# Gaiada — Module Changelog

Per-module change history. Format follows [Keep a Changelog](https://keepachangelog.com) +
[SemVer](https://semver.org) (all `0.x` — nothing is in production yet). **Append an entry on every
notable module change or commit; bump the version in [`MODULES.md`](./MODULES.md) to match.**

Status vocabulary: `PLANNED` · `IN PROGRESS` · `PROTOTYPED` (dev-only) · `DEV-VERIFIED` (e2e on the
local stack). None of these mean "production-done".

---

## Untagged — queued for the next app release cut

### platform-nest `0.41.0` - a provisioned site knows its client and project (2026-08-27) - DEV-VERIFIED

**Added**
- `webdev_provisioned_sites.client_id` / `project_id` (nullable FKs). Migration
  `202608270659_webdev_sites_client_project.sql` adds them, indexes them, and backfills rows that have
  a run from the run — per tenant AND with `app.scopes = webdev` set, because this table sits behind the
  third RLS wall (`app_module_allowed`) and a backfill without both GUCs matches zero rows and reports
  success.
- `POST /api/:t/modules/webdev/provision` accepts `clientId` / `projectId` for a STANDALONE site (no
  `runId`). With a `runId` the run's own client/project are copied and the caller's are ignored — a
  caller cannot file a run's repo under another client. The DTO gains `clientId` / `projectId` (the
  idempotency suite's exact-key allowlist updated deliberately).
- Why: a standalone repo could only ever read "not linked to a project" in the Repositories tab.
  Spec `2026-08-26-webdev-lineage-fields-design.md` (2/3).
- Tests: `webdev-controller-http.test.ts` (+1 lineage: run copy, standalone supplied, bare null,
  list returns both); webdev suites 103/103.

### platform-nest `0.40.0` - briefings and PRD runs know their department (2026-08-27) - DEV-VERIFIED

**Added**
- `meeting_recordings.department_id` and `pipeline_runs.department_id` (org-node id, free text —
  the shape `projects.department_id` already uses; nullable). Migration
  `202608270652_department_lineage_on_recordings_and_runs.sql` adds both, indexes them, and
  backfills existing rows through their project per tenant (the `set_config` pattern from 0051/0074;
  `lint:migration-rls` green). Rows with neither project nor department stay NULL — honestly unknown.
- `POST /api/:t/meetings/recordings/start` accepts `departmentId`; the list and detail reads return
  `department_id`.
- `POST /api/:t/pipeline/runs` accepts `departmentId` and derives it like `client_id`/`project_id`:
  the caller's value wins, else the source meeting's, else the project's. List and detail return it.
- Why: the Web Dev console inferred department ownership through the project, which fails for a
  briefing that has no project yet — and a briefing usually exists before its project. Spec:
  `docs/superpowers/specs/2026-08-26-webdev-lineage-fields-design.md` (1/3).
- Tests: `meetings.test.ts` (+1), `pipeline.test.ts` (+2) against the disposable test Postgres +
  live Cerbos — 79/79.


### platform-nest `0.39.2` - the finance seed counted calls, not writes (2026-08-26) - DEV-VERIFIED

**Fixed**
- ★ The seed reported **"11 posted"** on a run that created **4** journal entries. `posted` counted
  CALLS that did not raise, and `finance_post_journal` is idempotent on `source_event_id` - it
  returns the existing entry instead of raising, so a re-run tallied writes it never made. On a seed
  that writes to REAL, APPEND-ONLY books that reads as a double-post, and the only way to find out
  otherwise is to go and count the ledger by hand. Which is what happened: the ledger was correct
  (12 -> 16 entries, 8 distinct `demo-seed:` ids, no duplicates), the counter was lying.
- The ledger is now counted before and after, and the measured DELTA leads the output. The call
  tallies follow, explicitly labelled as steps that ran rather than as rows written.

**Verified on live after the AR/AP run**
- AR aging lands in TWO different buckets, as the differing payment terms intend: 46,600,000 at
  1-30 days (66.6m invoice less the 20m allocated, due 12 Mar) and 27,750,000 current (due 3 Apr).
- AP 38,150,000 = 35,000,000 + 3,850,000 PPN - 700,000 PPh 23, to the rupiah.
- `finance_ar_reconcile` and `finance_ap_reconcile` BOTH return zero problems - the subledgers tie
  to the general ledger.
- AR position: open 74,350,000 / on account 10,000,000 / net 64,350,000 - the unallocated remainder
  showing up as the three-part position exists to show.

---

### platform-nest `0.39.1` - the finance demo seed reaches the AR/AP subledgers (2026-08-26) - DEV-VERIFIED

**Fixed**
- ★ **The seed's central claim was FALSE.** Its header said every journal it posts carries
  `source_event_id` beginning `demo-seed:`, making the set reversible as a batch. Running it on live
  proved otherwise: 12 entries, 8 tagged, 4 NOT - three asset capitalisations and a depreciation
  charge, posted by `finance_capitalise_asset()`/`finance_run_depreciation()`, which mint their own
  `fa-acquire:`/`fa-depreciation:` ids. Cleaning up on the documented filter would have silently
  left those behind, the largest a 380,000,000 vehicle. The header and the CLI output now give the
  three queries actually required, and note that `finance_assets`/`finance_instruments` rows are not
  journals at all so a reversal does not touch them.
- The seed posted only CASH and direct GL entries, so `finance_ar_invoices` and `finance_ap_bills`
  stayed at zero and the Receivables/Payables tabs rendered empty beside a populated ledger. It now
  creates real subledger documents: two issued invoices on different payment terms, a receipt that
  is PARTLY allocated (30,000,000 banked, 20,000,000 allocated, 10,000,000 left on account - which
  is the case the three-part position exists to show), and an approved vendor bill with PPh 23.

**Notes**
- ⚠ A HEADER IS NOT AN INVOICE: `finance_ar_issue_invoice` refuses one with no lines
  (`FINANCE_AR_EMPTY_INVOICE`). Caught by dry-running the SQL against the LIVE schema inside a
  rolled-back transaction before it ever ran for real - not by a test, and not on live.
- Verified the same way: aging returns a row and `finance_ar_reconcile` returns ZERO problems, so
  the subledger ties to the general ledger.
- Live books after the first run: 12 entries, debits = credits = 1,509,000,000, zero unbalanced
  entries, P&L revenue 150,000,000 / expense 144,500,000 / net 5,500,000, of which 8,500,000 is
  exactly one month's depreciation on the three seeded assets.

---

### platform-ui `0.55.0` - PRD Studio reads as one flow: create, record, convert, approve (2026-08-26) - PROTOTYPED

**Changed**
- ★ `/departments/[deptId]/prd` was three unrelated forms (record now / register for the helper /
  upload) above a bare run table, with the "dispatch into the pipeline" button living on a different
  page and no trace of the approvals. It is now ONE flow with four numbered beats, and each beat
  shows only what that beat needs: **1 Create a briefing** (title, client — required, because the
  client sign-off needs one — project, audio/video; nothing records yet) → **2 Add the recording**
  (per-briefing card; the three capture methods appear only while there is no recording, one at a
  time) → **3 Convert to PRD run** (the only button once the transcript exists; ingest failures are
  said in plain words) → **4 Get it approved** (per run: a `GM review` chip from `prd_review` and a
  `Client sign-off` chip from `prd_sign`, one sentence saying who holds it; a GM approves / requests
  changes inline via the existing `decideGateAction`; the client beat is read-only and says it is
  signed in the portal).
- A flow strip at the top carries live counts per beat ("2 waiting for a recording · 1 with the GM").
- Frontend only, against endpoints that already exist. New: `lib/prdFlow.ts` (pure status→copy
  mapping, 15 tests), `components/prd/{PrdFlowHeader,BriefingComposer,BriefingCard,RunApprovalRow}`
  + `prd-studio.css` (tokens only). `RecordControls` is untouched — the client/project workspaces
  still use it. Demo store gains `rec-demo-4` (a briefing with no recording) so the capture step is
  drivable; two Playwright tests cover the strip, the per-state cards and creating a briefing.
- Driven in a browser under `DEMO_MODE=1` (all four beats, convert included) — not yet against a
  live platform, hence PROTOTYPED. Two console errors seen on the page pre-date it and live in the
  shell: a duplicate `pipeline:<gateId>` key from `lib/queue.ts` (work rail) and a hydration
  attribute mismatch under `(app)/layout`'s `<link>`.

- **Web Dev only.** The route is the generic `/departments/[deptId]/prd`, so the page now 404s for any
  department whose toolkit has no `prd` tab, and everything it lists is scoped
  (`lib/prdFlow.ts::scopeToDepartment`). **2026-08-27:** the stored `department_id` (platform-nest
  `0.40.0`) decides first — PRD Studio and a project's Meetings tab send `departmentId` on
  `/recordings/start`, and runs derive it — and the PROJECT inference is now only the fallback for
  rows that pre-date the column: a briefing belongs iff its project is this department's; a run iff
  its own `project_id` is (WD-30) or its source briefing's project is. Same rule in the Repositories
  inventory (`buildRepoInventory`).
  Consequence: every briefing needs a project (it is the only recording→department link) — and since
  in Reva's flow the project does not exist yet when the call happens, **the project is created WITH
  the briefing**: `lib/prdActions.ts::createBriefingAction` does `POST /projects` (name = briefing
  title, this client, this department) then `POST /recordings/start` under it, in one action; "Link
  an existing project" is the optional alternative. If the second write fails the message names the
  project that was created, so nothing is silently orphaned (6 action tests). Recordings and runs are
  tenant-wide on the backend — the SEO scope call in the demo store no longer appears as a Web Dev
  briefing, and the e2e asserts that. Demo `POST /projects` now adds the project to the list (it
  used to return an id that nothing could see).

- **Fourth capture method — "Upload a transcript".** Whether a transcription service (whisper) is
  hosted at all is still open, so a briefing can take its transcript directly: pasted, or from the
  file a call tool exported (`.txt`/`.md` as-is; `.srt`/`.vtt` with cue numbers, timestamps, cue ids
  and inline tags stripped — `components/prd/transcriptText.ts`, 6 tests). Saves through the existing
  `POST /:id/transcript` via `setTranscriptAction`; the row goes straight to `transcribed` and the card
  offers Convert. Also offered as "Upload a transcript instead" when transcription failed.
  **Speakers survive:** Teams/Meet `<v Name>` voice tags and Zoom `Name: …` lines become
  `Name: …` paragraphs, consecutive cues by one speaker merge, turns are blank-line separated — so
  the meeting tool's own transcript (the best free, speaker-labelled source; whisper cannot label
  speakers) reaches the PRD pipeline with who-said-what intact.

- **"Start the run without the AI draft."** "Convert to PRD run" = the platform's `ingest`, which
  hands the transcript to n8n's `mtg-dispatcher` (LLM summarize + 3 extractions) — and on a platform
  with no n8n / no LLM key it answers `bridge_not_configured` and nothing happens. The card now says
  that in plain words and offers the same run started by hand: `lib/prdActions.ts::startRunManuallyAction`
  → `POST /pipeline/runs` (source meeting, client, project, three PENDING stages; dedupes on the
  meeting id) → `PATCH /recordings/:id {status:"ingested"}` → best-effort `relink-orphans`. The run
  then reads "No PRD review yet — the PRD is drafted (by the pipeline, or written by hand) in the run
  workspace, then GM review is opened there", and the workspace's artifact editor + open-gate form
  carry it from there. Offered ONLY after `ingest` answers `bridge_not_configured`; other dispatcher
  errors stay errors. 5 action tests; demo `rec-demo-6` (meeting id `*-nobridge`) drives it in e2e.

- **Repositories tab is real.** It was a placeholder ("No repositories connected → Go to
  Connections") that read no data — and connecting GitHub there produces no repos anyway (that
  connection is an identity string; the GitHub App is WD-21/22, an owner action). It is now the
  department's **code inventory**: every repository the delivery pipeline provisioned
  (`webdev_provisioned_sites`, read tenant-wide via `GET /modules/webdev/provisioned-sites` with no
  `runId` — the endpoint already behaves that way — then attributed run → project → department,
  PRD Studio's rule; `lib/repoInventory.ts`, 6 tests). A `HairlineTable` (the same primitive the Projects,
  admin and finance surfaces use), one row per repo: name → GitHub (framework underneath), client ·
  project, status in environment words (`Provisioning` / `Staging` / `Live` / `Failed` —
  `REPO_STATUS_LABEL`; the run workspace keeps the finer "Provisioned (SSL pending)"), with the
  failure reason under the badge behind a "why?" disclosure, URL, the PRD run it came from, last
  check, and an Action column that exists only when a row has one (no column of dashes). Problems first; a failed row
  carries the plain-language reason from `webdevProvisionedSites.ts` and offers "Check status now"
  (existing `reconcileSiteAction`) or a link to the run to re-provision. Empty state says where repos
  come from (a provisioned run), not "connect GitHub". A GitHub line states the viewer's connection
  and that commit/PR activity needs the App. Module-off and refused reads are stated, not blanked.
  `components/repositories/RepoInventory` (7 tests); e2e drives the demo store's failed + live pair.
  **Create repository** (people with `webdev.provision`), two modes on the same endpoint
  (`POST /modules/webdev/provision`, which already accepted an explicit slug with no run —
  off-pipeline, `pipeline_run_id: null`): **Standalone** (default) — a name and a framework, no PRD
  run, no client/project, listed as "Not linked to a project · standalone"; **For a PRD run** — the
  run brings client and project (this department's runs with no active site; a failed-only run is
  offered again as a retry — `runsEligibleForRepo`), name pre-filled from the run title
  (`suggestSlug`). Both validate the name live against provision's slug grammar and call
  `provisionSiteAction` (now accepts no `runId` when a slug is given); the row lands as Provisioning.
  Direct GitHub creation outside provisioning stays fail-closed on the backend (WS11); this is the
  sanctioned manual path. `components/repositories/CreateRepoForm` (7 tests); e2e creates a standalone
  repo and provisions demo `run-demo-3`. **2026-08-27:** a standalone repo can carry its lineage —
  platform-nest `0.41.0` stores `clientId`/`projectId` on the site — so Standalone mode gains optional
  Client → Project pickers (that client's projects in this department; "client and project are
  optional") and `provisionSiteAction` forwards them; the inventory reads the site's own client ·
  project first and falls back to the run's, and a standalone site whose project belongs to another
  department is no longer listed here (`buildRepoInventory`, 2 more tests; `CreateRepoForm` +3; e2e
  creates a Northwind-linked standalone repo and sees "Northwind Traders · Client site redesign").
- **A project's Meetings tab is now the PRD Studio flow, filed under that project.** It used to be
  the old capture trio (record / register for the helper / upload) over a bare recordings table.
  `components/prd/ProjectBriefings` composes the same pieces PRD Studio uses — `BriefingComposer`
  with the client and project fixed ("Filed under …"), `BriefingCard`s in the same action order
  (`lib/prdFlow.ts::orderBriefings`, now shared with PRD Studio), and `RunApprovalRow`s for the
  project's runs with their GM / client beats — so the two surfaces cannot drift apart. Runs + gates
  are read only when that tab is shown. `RecordControls` remains for the client workspace.
- **A project belongs to a client; a client has many projects — shown that way.** The department's
  Projects tab groups projects under their client (clients A→Z, "Internal — no client" last;
  `page-helpers.ts::groupProjectsByClient`, tested), each client name linking to its hub. The project
  form gains a required **Client** picker (`?clientId=` pre-selects it; the old "no clients-list
  endpoint yet" comment was stale — `listClients` exists), and the project header shows **CLIENT**
  beside range/owner/tags. Frontend only: `POST/PATCH /projects` already carried `clientId`.
- **New project from the Projects tab.** A project no longer has to come out of a PRD run: the
  department's Projects tab has a "New project" button that opens the existing `/projects/new` form
  with the owning department pre-selected (`?departmentId=`).
  **`?preview=sample`** renders five sample rows (every status) behind a loud "Sample data — nothing
  here is from your platform" banner, offered from the empty and module-off states so the layout can
  be reviewed on a platform where nothing has been provisioned; real reads are skipped in preview so
  sample and real rows can never mix, and sample rows offer no actions.

**Fixed**
- **61 unstyled buttons.** `className="btn"` / `"btn btn-primary"` is used in 27 components (pipeline
  gates, PM forms, meetings, IT/HR actions…) and no stylesheet ever defined those classes — git has
  no `.btn` in its history — so they rendered as the browser's default grey button. Defined once in
  `components/ui.css` as the sentence-case sibling of `.lux-btn` (same hairline, radius token, accent,
  easing). New work should still use `.lux-btn--*`.
- ★ **Uploads over 1 MB failed** with `Body exceeded 1 MB limit` before anything reached the platform:
  every upload path went through a Server Action, and Next caps action bodies at 1 MB by default.
  Two-layer fix. `next.config.ts` raises `serverActions.bodySizeLimit` to 520 MB (the platform's
  `MEETING_VIDEO_MAX_BYTES` cap plus multipart overhead) for the paths that stay on actions — the
  in-browser take (`LiveRecorder` → `uploadAudioAction`) and `registerAndUploadAudioAction`. PRD
  Studio's "Upload a file" leaves actions entirely: the browser POSTs the file itself over
  XMLHttpRequest (the one API with upload progress) to the new BFF route
  `POST /api/meetings/[id]/audio`, which streams the multipart body to the platform unchanged
  (`duplex: "half"`, no buffering, platform's 413/415 passed straight back) — and the card shows
  `43% · 86 MB of 200 MB` while it goes. `components/prd/uploadWithProgress.ts` (6 tests, XHR
  injected); DEMO_MODE branch in the route updates the demo store like the action does.
  **Driven against the live host platform with a 170 MB video — three more walls fell on the way:**
  (1) forwarding the browser's `content-length` on a streamed hop → `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`;
  (2) piping `req.body` as a stream reached the platform truncated → the route now reads the body in
  full and sends one buffer (memory = file size, bounded by the 500 MB cap, same as `platformUpload`);
  (3) the real cut: **`experimental.middlewareClientMaxBodySize` defaults to 10 MB** — because the app
  has a `middleware.ts`, Next buffers every request body for middleware and truncates it there; the
  route received exactly 10,485,248 of 178,258,106 bytes and the platform's busboy error was reported
  as "exceeds the 524288000-byte cap". Raised to 520 MB alongside `bodySizeLimit`. The route now also
  refuses a body shorter than its `content-length` with a message naming that limit, instead of
  handing the platform a truncated multipart. Verified: 5 MB and 170 MB → 202 via the route.

**Known gap (frontend)**
- Gate chips need `GET /pipeline/runs/:id` per active run (the LIST carries no gates) — capped at 12;
  runs past the cap say "open the run to see its approvals" rather than guessing. A list-with-gates
  read on the backend removes the cap.

### platform-ui `0.54.0` - the five remaining finance tabs are real pages (2026-08-26) - PROTOTYPED

**Added**
- `/finance/accounts` - the chart of accounts, grouped in statement order. Shows `normal balance`
  (where SIGN comes from - a contra account is one whose normal balance runs the other way),
  whether manual posting is allowed, and which subledger owns each control account.
- `/finance/receivables` and `/finance/payables` - aging by bucket with the control-account tie-out
  rendered ABOVE the figures, plus the three-part position (open documents / payments on account /
  net). `components/finance/AgingTable.tsx` is shared by both.
- `/finance/tax` - the PPN position with UNCREDITABLE input VAT as its own tile rather than netted
  away, and the e-Faktur exception list with document, counterparty and amount at stake.
- `/finance/close` - per-period readiness, defaulting to the most recent OPEN period rather than
  today's, because on the 5th of a month the question is whether LAST month can be locked.

**Fixed**
- `FinanceTabs` set only `aria-current="page"`, but `shell.css` styles `.sec-tab--active`. The
  finance strip therefore had NO active-tab indicator - every tab looked identical. Every other tab
  strip (SectionTabs, DeptTabs) sets both; this now does too.
- `content-brief-sweep-job.ts` read `config.social.contentBriefSweep.*`; the config block is
  `config.social.contentBrief.weeklySweep.*`. That single wrong path was a platform-nest typecheck
  error plus 4 failing tests. ⚠ The file is NOT wired into `main.ts` - `content-brief-job.ts` is
  still the implementation that runs. Which of the two should be live is an open decision.

**Notes**
- No backend work: every endpoint already existed (`finance/accounts`, `ar|ap/aging`,
  `ar|ap/reconcile`, `tax/ppn`, `tax/efaktur-exceptions`, `periods/:id/close-readiness`) with
  readers already in `lib/finance.ts`. The tabs were never blocked on the platform.
- WRITE actions remain unbuilt and each page says so specifically rather than generically: raising
  an invoice / recording a receipt, entering a bill / releasing a payment (separated deliberately -
  they are a seeded blocking SoD conflict), preparing a return, and signing off + locking a period.
- The `[...unbuilt]` catch-all's PLANNED map is now EMPTY. A "not built yet" description sitting
  beside a page that exists is worse than none - it is confidently wrong. The route stays to catch
  a mistyped path without 404ing.
- Version 0.54.0 follows 0.53.0 (GM-02b/GM-09), which landed from a concurrent session while this
  was being written.

---

### platform-nest `0.39.0` - the `billing` module is now `invoice` (2026-08-26) - PROTOTYPED

**Changed**
- Module key `billing` -> `invoice`. Permission keys `billing.invoice.<action>` -> `invoice.<action>`
  (two-part, following the `portal.*` precedent for a domain whose name equals its Cerbos kind).
- `src/modules/billing/` -> `src/modules/invoice/`; `BillingController` -> `InvoiceController`;
  MCP tool `billing.listInvoices` -> `invoice.listInvoices`.
- UI `/billing` -> `/invoices`; `lib/billing.ts` -> `lib/invoice.ts`; `lib/billingActions.ts` ->
  `lib/invoiceActions.ts`. Nav label "Billing" -> "Invoices".
- Migration `202608261030` moves the STORED copies: `companies.enabled_modules`,
  `service_assignments.module_key`, `permissions.key`, and the rollup registry's `module`.

**Why**
- The owner's framing: *"The billing system is supposed to be for the outside contract. gaia digital
  agency and its clients"* - and what that produces is an invoice. Every route
  (`/api/:t/invoices`), every table (`invoices`) and the Cerbos kind (`resource_invoice`) already
  said so; only the module key, its permissions and its UI path disagreed.
- "Billing" also named two UNRELATED things in this tree - a client's billing ADDRESS, and vendor
  billing in the search providers - so the word carried three meanings. Those two are untouched.

**Notes**
- ★ **Grants are preserved because the migration UPDATEs `permissions.key` in place.**
  `role_permissions` keys off `permission_id` and cascades on delete, so a delete-then-insert would
  have silently stripped the capability from every role holding it - 17 rows across the baseline
  roles on the live estate, with nothing reporting the loss.
- `service_assignments.module_key` is immutable by trigger (correctly - an assignment is a standing
  agreement to serve a NAMED module). The migration disables that trigger for exactly one statement
  and re-enables it; `billing-rename.db.test.ts` asserts it came back on.
- ★ **The rename is tested against a database that HAS THE OLD NAMES.** Every other suite runs on a
  fresh database where the new name is simply the name, so they all pass with the migration deleted
  - the seed-rename trap in `platform-nest/CLAUDE.md`, one layer down.
- `/billing` survives as a 308 redirect (optional catch-all, so `/billing/<id>` lands on that
  invoice). Old links live in bookmarks and in notification rows already written to the database,
  which are historical records and must not be rewritten. The shim can go once those age out.
- 4036 backend tests green; the 4 reds are another session's `config.social.contentBriefSweep`.
  `CAPABILITY-INVENTORY.md` and `role-permission-bundles.json` regenerated (17 pairs moved).

---

### platform-ui `0.52.0` - a finance WORKSPACE, not a dashboard (2026-08-25) - PROTOTYPED

**Added**
- `(app)/finance/layout.tsx` + `FinanceTabs` - the workspace shell.
- `/finance/journals` + `/journals/[entryId]` - post, list, open, reverse.
- `/finance/ledger` - one account's movements with a running balance.
- `/finance/reports` - trial balance, P&L, balance sheet.
- `/finance/[...unbuilt]` - an honest surface for a tab whose page is not built.

**Why**
- The owner's assessment: */finance* was *"a mash of info put into a page"*. One scrolling console
  carried KPIs, three verdicts, two agings, the close gate, the calendar and a config card.
  Everything was on screen and nothing was findable - the cap-table links sat below three tables
  nobody scrolls to. More importantly **there was no way to POST anything**: the engine has had a
  hash-chained double-entry ledger since F1 and nothing could reach it.

**Notes**
- ★ **The journal form's running totals are an AID, NOT A GATE.** It shows the difference but does
  not block on its own arithmetic: if it did, any rounding difference between JS floats and Postgres
  numeric would make a valid entry permanently unsubmittable. The database decides what balances.
- **The badge reads `status`, not `kind`.** "reversed" (this entry WAS undone) and "reversal" (this
  entry UNDOES another) are different facts; collapsing them renders a cancelled entry identically
  to its canceller.
- **The general ledger's running balance comes from the SERVER.** Accumulating it in the component
  is trivial and is exactly the temptation to refuse - `finance_account_movement()` uses the
  account's own `normal_balance` for direction, so credit-normal accounts (accumulated depreciation,
  payables) run the right way without the page knowing anything about contra accounts.
- **Each statement says whether it balances ABOVE the figures.** A trial balance whose debits do not
  equal its credits is not a report with a small problem.
- **An unbuilt tab states what already works behind it.** A 404 reads as "the app is broken".

### platform-ui `0.53.0` — 2026-08-26 — GM console: the money tier (GM-09), and the block that dissolved

**Status: PROTOTYPED.** Driven in a browser against a DEMO_MODE build; not against live platform-nest.
Tracking: [`../plans/2026-08-24-gm-console-PROGRESS.md`](../plans/2026-08-24-gm-console-PROGRESS.md).

**GM-09 was blocked for the entire build, correctly, and then the ground moved.** The only money data
in the estate was `GET engagements/:id/ledger` — one department's search-marketing provider spend —
and OQ-3 forbade summing it into a company figure, so the money half shipped behind an honest
`BackendPending` banner. A real double-entry finance module then landed (`finance_profit_and_loss()`
in Postgres, Cerbos-authorized statements, AR/AP aging), and revenue and margin became available from
the BOOKS at exactly the grain the cockpit needed.

Worth stating plainly, because the temptation recurs: **had the engagement-ledger shortcut been
shipped, the console would now carry a figure that disagrees with the general ledger**, and the fix
would be a migration away from a number people had started quoting in reviews. A `BackendPending`
banner is not a stalling tactic — it is a position that stays correct while the estate changes.

- `lib/gmMoney.ts` — pure, 13 tests. Reads the P&L's own `TOTAL_REVENUE`/`TOTAL_EXPENSE`/`NET_PROFIT`
  rows rather than re-summing lines (re-summing would agree with the ledger only until the first
  contra-revenue account). Money parses at the edge and may fail to `null`; **never 0**, because "we
  earned nothing" is the most expensive wrong answer this surface can give. Margin on zero revenue is
  `null`, not 0% — undefined, not a value.
- `GmMoneyCard` — three states that must not look alike, behind the `listPeriods` gate read (the one
  finance reader that distinguishes 403 from 404): **forbidden** / **no fiscal calendar or module not
  enabled** / **real books**. Compact on the cockpit, full on the tab.
- Cockpit renders it **last**, below both operating tiers — the cadence rule this console follows puts
  financials at the end of the deck. It first shipped in the middle by mistake; the e2e ordering
  assertion caught it.
- New `finance.statement.view` + `finance.ar.view` capability mirrors, accepted by the 1151-pair
  parity guard.
- Owner rulings: money answers **"are we making money?"** first; **compose and link out** to
  `/finance`, never a second finance console; **active company only**.

**Findings carried out of this work**

1. **Three finance roles have no UI `Role` member.** `finance.statement.read` is held by
   `company_admin`, `finance_manager`, `finance_staff`, `owner`, `platform_admin` — but the middle
   three do not exist in `rbac.ts`'s union, so they resolve to **zero capabilities** across the whole
   app. Same defect class as that file's own Gap 1/2/3 comments. It affects the entire `/finance`
   console, not the GM tier, so it is reported rather than widened inside a GM ticket.
2. **DEMO_MODE modelled no finance authz whatever** — `financeDemo` did not take a `userId`, so a
   plain member was served the company's books. Fixed with a holder set returning **403**, not empty
   fixtures: `lib/finance.ts` deliberately distinguishes refusal from absence and empty fixtures would
   have destroyed that distinction. Third fixture-fidelity gap this session; worth treating as a
   pattern.
3. **`mode: "serial"` (added the day before) was the wrong fix** — it skips every later test in a group
   when one fails, so a single stale assertion reported "1 failed, 21 did not run" and hid the rest.
   Replaced with `fullyParallel: false` on the `gm` project: same single-worker sequencing, independent
   pass/fail.

### platform-ui `0.52.0` - a finance WORKSPACE, not a dashboard (2026-08-25) - PROTOTYPED

**Added**
- `(app)/finance/layout.tsx` + `FinanceTabs` - the workspace shell.
- `/finance/journals` + `/journals/[entryId]` - post, list, open, reverse.
- `/finance/ledger` - one account's movements with a running balance.
- `/finance/reports` - trial balance, P&L, balance sheet.
- `/finance/[...unbuilt]` - an honest surface for a tab whose page is not built.

**Why**
- The owner's assessment: */finance* was *"a mash of info put into a page"*. One scrolling console
  carried KPIs, three verdicts, two agings, the close gate, the calendar and a config card.
  Everything was on screen and nothing was findable - the cap-table links sat below three tables
  nobody scrolls to. More importantly **there was no way to POST anything**: the engine has had a
  hash-chained double-entry ledger since F1 and nothing could reach it.

**Notes**
- ★ **The journal form's running totals are an AID, NOT A GATE.** It shows the difference but does
  not block on its own arithmetic: if it did, any rounding difference between JS floats and Postgres
  numeric would make a valid entry permanently unsubmittable. The database decides what balances.
- **The badge reads `status`, not `kind`.** "reversed" (this entry WAS undone) and "reversal" (this
  entry UNDOES another) are different facts; collapsing them renders a cancelled entry identically
  to its canceller.
- **The general ledger's running balance comes from the SERVER.** Accumulating it in the component
  is trivial and is exactly the temptation to refuse - `finance_account_movement()` uses the
  account's own `normal_balance` for direction, so credit-normal accounts (accumulated depreciation,
  payables) run the right way without the page knowing anything about contra accounts.
- **Each statement says whether it balances ABOVE the figures.** A trial balance whose debits do not
  equal its credits is not a report with a small problem.
- **An unbuilt tab states what already works behind it.** A 404 reads as "the app is broken".

### platform-ui `0.51.0` - the cap table and accounting settings become editable (2026-08-25) - PROTOTYPED

**Added**
- `/finance/ownership` (UI-01c) and `/finance/settings` (UI-02b), `lib/financeActions.ts`,
  `components/finance/{OwnershipEditor,SettingsEditor}.tsx`, demo fixtures.

**Notes**
- ★ **`listOwnership` returns `null` on 403, never an empty list.** `finance_ownership:read` is a
  narrower grant than the rest of finance - a `finance_staff` clerk is denied outright - so a 403 is
  the COMMON case here. Folding it to `{edges:[],problems:[]}` would render "this company has no
  recorded owners", an active false statement about the cap table rather than a missing one.
- **`problems[]` renders beside the rows, not behind a tab.** A cap table totalling 85% or 140% has
  to say so where it is read; anywhere else and the common case - glance, believe it - shows a
  register that looks authoritative and is not.
- **`STAKE_INCOMPLETE` is a note, `STAKE_EXCEEDS_100` is a problem.** Same shape of data, different
  treatment: one is ignorance, the other is wrong. A partially-recorded cap table is the normal
  state of a real one.
- **Neither form re-validates a server rule.** The 15/16-digit NPWP check and the posted-VAT guard
  live in the database and their messages surface verbatim. A second copy drifts, and the copy that
  drifts is the one the user sees.
- **The settings page shows the fiscal year start read-only WITH the reason.** A field that exists
  and then fails is worse than one never offered: the field implies permission and the refusal
  arrives after the user has decided what they want.
- **Configuration links from the console, not the sidebar.** `nav.ts` renders exactly one Finance
  row on purpose; two more top-level rows would fight that dedupe.
- The demo cap table totals **85%**, deliberately, so the incomplete-table copy is reachable in a
  browser. A demo that adds up perfectly hides the reason the validation exists.

### finance `0.14.1` - FinanceErrorFilter no longer swallows other modules' database faults (2026-08-25) - PROTOTYPED

**Fixed**
- `finance-error.filter.ts` delegates a NON-`FINANCE_*` `DatabaseError` to
  `LastResortExceptionFilter` instead of answering in its place.
- `provider-dispatch-error.filter.test.ts` - `FinanceErrorFilter` added to the pinned filter order.
- `finance-error.filter.test.ts` - 5 tests, one of which is the regression guard.

**Notes**
- ★ **The bug was invisible by construction.** The filter is `@Catch(DatabaseError)`, so it
  intercepts EVERY pg error in the estate, not only finance's. It replied 500 with exactly the body
  `LastResortExceptionFilter` uses - but LastResort ALSO writes `[unhandled-exception]` to stderr
  and records the fault on the active OTel span. So every non-finance database fault became a
  SILENT 500: identical response, no log line, no trace. Nothing about the response could reveal it.
- Delegating keeps ONE implementation of "what do we do with an unhandled fault", so a later change
  there cannot drift from a copy hiding in the finance module.
- **The order-pin test was right to fail.** `provider-dispatch-error.filter.test.ts` asserts the
  EXACT registered filter list precisely so a filter added to `main.ts` cannot ship unreviewed. It
  caught this one. The fix records the addition and states why this filter's `@Catch` type is NOT
  disjoint from the others - it is the entry that needed reasoning about, which is what the test is
  for.

### finance `0.14.0` - F8 complete + F9 consolidation begins (2026-08-25) - PROTOTYPED

**Added**
- `202608251130` capitalisation, the depreciation run, the register/GL tie-out.
- `202608251230` disposal, impairment, deferred tax (PSAK 46), the close interlock.
- `202608251330` the fixed-asset movement schedule.
- `202608251430` intercompany tagging.
- `202608251530` control determination, the consolidation group, a SEPARATE consolidation ledger,
  and the first elimination.
- 45 tests across five suites.

**Notes**
- ★ **Tax depreciation is recorded and never posted.** Book depreciation is an entry in the books;
  tax depreciation is a figure on a computation. Posting both would give statements that look
  plausible and are wrong in a way no reconciliation could catch - both sides consistently wrong.
- ★ **Deferred tax ADJUSTS TO A TARGET**, it does not post the computed figure. Posting the figure
  each period accumulates it: by year three the sheet carries three times the real balance while
  every individual entry looks correct.
- ★ **Eliminations never touch an entity's books.** An elimination is true of the GROUP and false of
  the ENTITY. Posting one into a subsidiary would make its standalone statements and its tax return
  wrong, and leave an auditor looking at entries with no supporting transaction.
- **The intercompany counterparty lives on the ACCOUNT, not the journal** - the ledger is immutable,
  so a journal tag could only be set at posting time via a 13th parameter on a 313-line function
  with seven callers. An account must be CHOSEN, so a mis-posted related-party balance is visible.
- **Two real defects the suites caught.** (1) Intercompany account codes took the FIRST 4 hex chars
  of a uuid v7, whose leading digits are a millisecond timestamp - companies created in the same
  millisecond collided and `ON CONFLICT DO NOTHING` silently returned another counterparty's
  account. Now uses the random tail and refuses on collision. (2) Both finance seeds wrote
  `user_roles` outside the P2-04 choke point without being on the TRUSTED allowlist.
- **Consolidation is bounded by `root_company_id`** - `withTenants` refuses a tenant set spanning
  two roots, and reading both sides of an intercompany balance is a two-tenant read. Correct: two
  unrelated holdings must never consolidate.

### platform-ui `0.51.0` - network security console: traffic, threats, isolation, occupancy (2026-08-25) - PROTOTYPED

**Added**
- `src/lib/network.ts` - data layer + the BFF contract for `GET /api/:t/it/network/{traffic,threats,rules,presence}`
  and `POST .../isolate`, plus pure helpers (`topTalkers`, `egressByCountry`, `summarizeThreats`,
  `isFeedStale`, `describeExpiry`, `canProposeIsolation`). 25 tests in `network.test.ts`.
- `src/lib/demoNetwork.ts` - labelled fixture fallback, seeded from the 2026-08-25 office survey.
- `/it/network` (Traffic), `/it/network/threats`, `/it/network/rules` (Isolation),
  `/it/network/presence` (Occupancy), under a new `Network` tab in the IT console.
- `components/it/network.css`, `components/it/NetworkBanners.tsx`.
- Explicit `demoFixtures.ts` routes for the four endpoints.
- Design: `docs/superpowers/specs/2026-08-25-network-security-console-design.md`.

**Notes**
- ★ **The fourth plane.** `/it/topology` answers "what exists on the network" and
  `/systems/observability` answers "what are we running". Neither can answer "what moves, and can we
  stop it" - device inventory says nothing about who a device talks to. That needs flow + IDS data,
  a different source with different volume and a different retention policy.
- ★ **A fixture must never pass for live data.** Every response carries a `source` discriminator and
  every page renders a loud banner on `"fixture"`. This is the direct countermeasure to the 8
  invented devices at a nonexistent "Bali Office" that sat in the live tenant for months reading as
  a topology bug. **In production these pages render fixtures + banner until the Phase 3 backend
  exists** - deliberate, so the surface can be reviewed, but see the design doc if that trade should
  be reversed to an empty state.
- **No staff-identifying data in a committed fixture.** ~25 of the 40 client hosts have hostnames
  naming the employee holding the phone. Corporate asset names are real; every personal device is
  collapsed into an unnamed aggregate - which is also how the shipped product must treat them.
- **`demoFixtures.ts` routes are explicit, not incidental.** That file's final GET catch-all answers
  unmatched paths with `ok([])` - an empty ARRAY - and these readers expect an OBJECT, so falling
  through would hand the pages `rollups: undefined` and crash the render instead of degrading.
- **Occupancy is a facilities tool, worded as one.** Zones, occupancy, sensors - never "detection",
  never "intruder", never a name. `PresenceZone` has nowhere to put a person; the wording is the
  reminder, the shape is the guarantee.
- **Enforcement renders read-only.** Isolation will ride D14 (`approval-executables.ts`), be
  quarantine-scoped only, refuse four protected targets server-side including the approver's own
  host, and auto-expire. None of it is built, so the page states that rather than offering a button
  that would 404.
- `HairlineTable`'s grid has no column gap: a right-aligned header renders flush against the next
  left-aligned one and the two read as a single word. Found only by driving the page in a browser,
  after four green builds. Every right-aligned column now sits at the end of the table.

### finance `0.13.0` - F8 fixed assets: book AND tax depreciation (2026-08-25) - PROTOTYPED

**Added**
- `202608251030_finance_fixed_assets.sql` - `finance_asset_classes`, `finance_assets`,
  `finance_depreciation_runs`/`_lines`, `finance_tax_golongan_params()`,
  `finance_asset_depreciation_schedule()`.
- `src/db/finance-f8-fixed-assets.test.ts` - 14 tests.
- CoA template gains `1260` / `2250` (deferred tax balances), `6750` (impairment), `7400`
  (disposal result).

**Notes**
- ★ **Two schedules, deliberately.** Tax depreciation is statutory (golongan fixes life and
  permitted method); book depreciation is a PSAK 16 management estimate. They routinely disagree,
  and that difference IS the temporary difference feeding deferred tax - not an inconsistency to
  reconcile away. Keeping one number would move the other into a spreadsheet outside the ERP.
- **The final period absorbs rounding.** 10,000,000 over 3 months rounds to 3,333,333.33 x 3 =
  9,999,999.99. Charging the rounded figure every month strands a cent of book value on a fully
  depreciated asset forever, and it never reconciles against the GL.
- **Declining balance terminates.** Saldo menurun approaches zero asymptotically; the final period
  writes off the remainder. Without it an asset depreciates past its life by amounts small enough
  that nobody notices for years.
- **Buildings on saldo menurun are refused by CHECK**, not by the UI - the method is not permitted
  for them and a wrong tax return is not something anything downstream would catch.
- **Idempotency is a UNIQUE INDEX**, not a code path: one depreciation run per period, which is the
  only version that survives a retried job or two concurrent operators.
- The new CoA accounts are added to the TEMPLATE only. `finance_instantiate_coa()` reads
  tenant-scoped tables behind `app_module_allowed('finance')` and a migration has no such scope, so
  a back-instantiate loop there would write ZERO rows and report success. Re-run
  `seed:finance-config` (idempotent by code) to pick them up.

### finance `0.12.0` - live defaults: PKP, a finance seat, and the ownership edge (2026-08-25) - PROTOTYPED

**Added**
- `seed:finance-live-defaults` - PKP status, a finance seat, and the default ownership edge.
- `docs/PLACEHOLDER-PRINCIPALS.md` - the register of stand-in principals in the LIVE estate.

**Notes**
- ★ **Anthony gets ONE ownership row, not three.** The obvious reading of "Anthony 100%" is one
  row per company, and it is wrong in a way that quietly misstates the cap table. `kind='holding'`
  confers the company **plus every descendant** through `finance_owner_company_ids()`, and both
  operating companies are children of the holding - so a single edge already reaches all three.
  Three `shareholder` rows would resolve to the same set while asserting he holds the operating
  companies directly rather than through the holding vehicle, and `shareholder` deliberately
  carries no group reach. One edge says what is actually true.
- **`anthony@gaiada.com` is a real active account**, so ownership is NOT a placeholder.
- **The finance seat IS a stand-in** and is registered as P-01/P-02. A grant made without that
  register entry is a defect: a stand-in grant is invisible once made - `hansel@gaiada.com` already
  holds platform-wide access, so a finance grant on top produces no warning and looks identical to
  a correct assignment.
- ⚠ **SoD is not in force in the live estate.** The accountant and the finance manager are the same
  account. Acceptable while the books are empty; not once real transactions are posted - the ledger
  is append-only, so entries posted under a stand-in stay attributed to that person permanently and
  reassigning the role later does not re-attribute history.
- **Every value here is a DEFAULT and never overwrites one already set.** PKP is guarded on
  `is_pkp IS DISTINCT FROM true`, so a company an accountant deliberately marked non-PKP is not
  silently flipped back by a re-run.
- The seed refuses to CREATE users. Inventing a principal in a live estate is how a fictional
  employee ends up holding a finance grant.

### finance `0.11.0` - the seed can configure a LIVE estate (2026-08-25) - PROTOTYPED

**Added**
- `seed:finance-config` takes `--company=` (repeatable), `--year=` and **`--no-seats`**.

**Notes**
- ★ **`--no-seats` is the point.** The two `.local` seats exist so dev is not blocked on a hire.
  Seeding them into a live estate would put two fictional employees into production IAM holding
  real finance grants - in the one module where a principal has money attached. Config (chart,
  calendar, settings) is safe to seed anywhere; principals are not.
- Defaults are unchanged (`Gaia Digital Agency`, seats ON, current year) so the documented dev
  invocation and `finance-config.db.test.ts` behave exactly as before. Verified: 4/4 green.
- The live estate is seeded through this script rather than hand-rolled SQL deliberately. Every
  `finance_*` table composes `app_module_allowed('finance')`, so a statement run without the module
  scope set writes **zero rows and reports success**. The seed sets it; a psql session would not.

### platform-nest `0.38.1` - platform boots in seconds, not minutes (2026-08-25) - IN PROGRESS

**Fixed**
- `src/main.ts` - `runWorkActivityBackfill()` is no longer `await`ed ahead of `app.listen()`.
- `src/core/work-activity-backfill.ts` - the history scan skips already-ingested rows.
- `infra/compose/docker-compose.vps.yml` - platform healthcheck `start_period` 10s -> 300s.

**Why (the 2026-08-24 502)**
- platform took ~129s to reach "Server listening" on the live box. Its healthcheck allowed
  10s + 20x5s = 110s, so compose called it unhealthy **19 seconds before it was ready** and
  aborted `up -d` with "dependency failed to start". The abort is the damage: it leaves
  platform-ui, mcp-hub, knowledge, report-renderer and agent-runner in the **CREATED** state,
  never started. nginx and platform were both healthy; platform-ui simply was not running, so
  every public request 502'd. Both automatic rollbacks failed identically, for this reason.
- ~117s of that 129s was one statement: the work-activity backfill re-read the **entire**
  `activities` history for every company on every boot, then did three sequential round-trips per
  row (fallbackTitle, hintPayload, ingestWorkActivity) purely for ingest's `ON CONFLICT` to throw
  the result away.

**Notes**
- ★ **Two independent defects, fixed independently.** The healthcheck budget was too tight AND the
  boot was too slow; either alone would have caused this again. Raising the budget without fixing
  the boot just moves the cliff.
- The anti-join preserves semantics exactly. `work_activity`'s dedupe key is
  `(tenant_id, source, source_ref)` and `source_ref` IS the activity's id, so an existing row means
  already-ingested. The rerun contract was already "every row dedupes and reports 0" - it now
  reaches the same end state without doing the work. `source_ref` is TEXT and `activities.id` is
  UUID; the suite caught the missing cast (`operator does not exist: text = uuid`). The UUID side
  is cast, never `source_ref`, so the index stays usable.
- **Backfill -> consumer ordering is still load-bearing** and preserved. The consumer advances the
  stream position, so starting it first could carry it past the history the backfill replays. On
  failure the chain retries with capped backoff rather than starting the consumer - the old
  crash-and-restart intent, without taking the whole API down to retry a background job.
- Not fixed: `report-renderer` carries the same 10s `start_period`. It currently reaches healthy in
  ~20s so it is not biting, but it is the same latent shape.

### finance `0.10.0` - the /finance console + the config seed (2026-08-25) - PROTOTYPED

**Added**
- `platform-ui/src/lib/finance.ts` - the data layer, with TWO deliberate degradation strategies.
- `platform-ui/src/app/(app)/finance/page.tsx` - the overview console: position KPIs, the four
  integrity verdicts, the close gate, AR/AP aging and the fiscal calendar.
- `platform-ui/src/lib/demoFinance.ts` - DEMO_MODE fixtures (the build gate runs in demo mode).
- `platform-nest/src/seed/finance-config.ts` + `.db.test.ts` - `npm run seed:finance-config`.
- `docs/FRONTEND-BFF-CONTRACT.md` - the finance section.

**Notes**
- ★ **A verdict must never degrade to a pass.** Four figures on this page are checks that mean
  "problems found; empty = pass". The estate's usual `skipUnavailable(p, [])` would render a green
  tick for a check that never ran. So `lib/finance.ts` has `financeData` (may degrade) and
  `financeVerdict` (returns null), and the page renders "not checked" as visually distinct from a
  pass. This is the single most important line in the UI work.
- **The nav dedupes Finance.** An org structure frequently contains a department called Finance
  (nav.test.ts's own wide-estate fixture has one), so appending a functional row the way HR and IT
  are appended would render "Finance" twice, pointing at two different screens. The org row is
  re-pointed at the console instead; a functional row is added only when no department claims the
  name. Pinned by test.
- **`listPeriods` distinguishes 403 from 404**, because the page keys its empty state off it - and
  "you have no finance access" and "this company has no calendar" need opposite sentences. The
  first draft told a member with no access to go and run a seed script.
- **The demo fixture is deliberately not all-green**: one subledger does not tie and the current
  period is unsigned, so the "does not tie" badge, the problem table and the close blockers are
  reachable in a browser. A books-perfect demo cannot exercise the parts of this console that
  matter.
- **The seed does NOT sign off a period.** It seats a finance_manager and a finance_staff, enables
  the module, instantiates the chart and cuts the calendar - but stamping `signed_off_by` with a
  seeded persona would satisfy the D-F5 control while destroying the only thing it protects.
  Nothing else is blocked by it.

### finance `0.9.0` - FA Application Layer (2026-08-24) - PROTOTYPED

The surface a person can actually reach. Until this, the whole program was schema + SQL + policy.

**Added**
- `src/modules/finance/index.ts` - the module contract, registered in `main.ts` and `app.module.ts`.
  21 declared permissions; 6 MCP tools, all READ-ONLY.
- `src/modules/finance/finance.controller.ts` - 19 endpoints under `/api/:tenantId/finance/*`.
- `src/modules/finance/finance-error.filter.ts` - maps the `FINANCE_*` refusal family onto HTTP.
- `src/modules/finance/finance.test.ts` - 19 tests against live Postgres + RLS + Cerbos.
- `docs/modules/CAPABILITY-INVENTORY.md` regenerated (generated artifact).

**Notes**
- **The controller computes no accounting.** Every figure comes from a SQL function; it authorizes,
  scopes and shapes JSON. The invariants stay next to the data where a script cannot walk past them.
- **`withFinance()` is the only database path.** Every finance table is module-walled, so a plain
  `withTenants()` returns zero rows with a 200 and looks like it worked. The first API test exists
  to fail if that helper ever loses its module scope.
- ★ **The fifth body-less 500 in this estate.** An unbalanced journal returned
  `500 {"error":"internal error"}` - the database had computed `debits (100) <> credits (90)` and
  the transport discarded it, because plpgsql errors arrive as pg `DatabaseError` and
  `HttpErrorFilter` only catches `HttpException`. Fixed with a typed filter scoped to
  `@Catch(DatabaseError)` - NOT a bare `@Catch()`, which broke the controller's own 400s because
  re-throwing from inside a filter does not reach the next filter. Unrecognised `FINANCE_*` codes
  default to 409 with their own message, so future refusals map by construction.
- **MCP is read-only this wave.** An agent may inspect the trial balance, the aging and the close
  blockers. No tool posts a journal: under D14 that must be a proposal a human approves, and the
  finance approval surface does not exist yet.
- **Rollup providers deliberately empty** - a group-level finance metric would be a cross-company
  money figure, and a naive sum double-counts intercompany (blueprint 10.3a). Needs F9.

### lms `0.7.0` + lab-runner `0.2.1` — L6 and L7 (2026-08-25) — DEV-VERIFIED

**Added**
- L6a: companion-target support in the runner (`buildTargetArgs`), plus the deliberately
  vulnerable `lab-runner/targets/webapp-cmdi` image.
- L6b: a DevOps lab graded on real `nginx -t` output. L6c: a Cyber lab against the target.
- L7: `lms-creative-social-curriculum.ts`, `lms-seo-gm-curriculum.ts`, `lms-hr-it-curriculum.ts` —
  20 courses, 12 paths, 64 activities across six departments.

**Fixed**
- **gVisor does not proxy Docker's embedded DNS on `--internal` networks**, so an attacker could
  never resolve its target by alias. Resolved via `--add-host` with the target's real IP.
- **`buildLabRequest` dropped `target`** — the Cyber lab would have been gradeable in isolation
  and dead on arrival for a learner.
- **The Cyber flag was hardcoded in the seed and the test.** Caught before push. Now read from
  `LMS_CYBER_FLAG`, refused if unset, and asserted by shape rather than value — the first version
  of that assertion printed the flag on failure, which is the same leak by a slower route.
- **`spec-redaction.ts` now strips the WHOLE `gradingSpec`**, not just `answer`. A Cyber lab's
  pass condition is "did you get the flag", so the flag lives in a `stdoutMatches` pattern.

**Notes**
- The target is as hardened as the attacker and never publishes a port.
- No DevOps/Cyber lab existed before the runner could grade them: a required activity nothing can
  pass makes its whole path permanently uncompletable.
- Suites were re-run SERIALLY. Four agents against one test Postgres produced a `57P01` failure
  that was contention, not a defect — a green or red number gathered under that load is not
  evidence either way.

Driven: 95/95 across 9 suites. Runner 31/31.

### lms `0.5.0` + lab-runner `0.1.1` — L5 complete: labs run on a real host (2026-08-25) — DEV-VERIFIED

**Added**
- `202608250950_lms_l5_lab_runs.sql` — the dispatch record and its rate-limit index; plus the
  `ux_lms_attempts_id_tenant` that every other lms_* table already had.
- `src/modules/lms/lab-dispatch.ts` + the lab branch of `submitAttempt`.
- `src/seed/lms-webdev-labs.ts` + `seed:lms-webdev-labs` — FE, BE and QA labs.
- Tests: `lab-dispatch.test.ts` (7), `lms-webdev-labs.db.test.ts` (9).

**Verified on the deployed runner, both directions**
- Every REFERENCE solution scores 100 under gVisor on SumoPod.
- Every untouched STARTER scores 0 (QA: 14.29). A lab whose starter passes teaches nothing.

**Notes**
- The graded test file is a challenge FIXTURE, never a starter. A learner file cannot displace a
  fixture — overwriting test.js with `process.exit(0)` is the obvious full-marks exploit.
- The QA lab inverts the usual exercise: the implementation is given and broken, and the learner
  is graded on whether their tests FAIL against it and PASS against a correct one — the only
  definition of a useful test.
- No DevOps or Cyber lab is authored. Both need runner capability that does not exist until L6.
### lab-runner `0.1.0` — L5a The lab execution sidecar (2026-08-25) — PROTOTYPED

A new standalone service. Executes a learner's submission in a capped, unprivileged,
network-less container and returns a graded result. `lab-runner/README.md` is its own guide.

**Added**
- `lab-runner/` — `config.ts` (every default chosen against SumoPod as measured), `sandbox.ts`
  (the docker argument list — the security boundary), `queue.ts` (hard concurrency cap, bounded
  backlog, refusal rather than an unbounded wait), `grade.ts` (four check kinds, server-side),
  `runner.ts`, `server.ts` (three routes, no framework).
- 25 unit tests: `sandbox.test.ts` pins every isolation flag; `grade.test.ts` pins the grader.

**Fixed during the end-to-end drive — neither was visible to the unit tests**
- A plain `--tmpfs /work` is created ROOT-OWNED, so `--user 65534` could not write a byte to it.
  Every run failed with `cp: can't create '/work/...': Permission denied`.
- A docker VOLUME chowned by a prep container looked like the fix and is not portable: Docker
  Desktop masks volume ownership per container, so the chown appears to take and the next
  container still sees `root`. `chmod 0777` behaves the same way. Verified directly.
  Fix: `--tmpfs /work:rw,nosuid,size=128m,mode=1777,uid=65534,gid=65534`.

**Notes**
- **NO KVM on the target host.** Containers are the only boundary, on a box sharing a kernel with
  19 containers of the owner's private production.
- **`image` is a KEY into an allow-list**, never a reference. Honouring a caller-supplied image
  there would turn the endpoint into "run anything as that image's entrypoint".
- **`fileExists` is forgeable and says so.** The artefact listing comes from inside the learner's
  own container; pair it with a `stdoutMatches` on the real tool's output for anything that
  matters. No artefact report can be non-forgeable while the learner controls the producer.
- Limits are CLAMPED, never honoured. A spec with no checks scores zero, never 100.

**Not yet true:** not deployed. No platform-side dispatch (L5b), no labs (L5c), and nothing on
SumoPod has been touched.

### lms `0.4.0` — L4 The Web Dev curriculum (2026-08-25) — PROTOTYPED

Six disciplines, ordered, foundation through lead. Structure and theory; the hands-on labs are L5.

**Added**
- `src/seed/lms-webdev-curriculum.ts` + `seed:lms-webdev-curriculum` — 8 paths, 14 courses,
  42 activities, 14 graded quizzes. FE · BE · UI/UX · DevOps · Cyber Security · QA, plus a shared
  foundation path and a lead path.
- `src/seed/lms-webdev-curriculum.db.test.ts` — 7 tests.

**Notes**
- **No `lab` is authored, deliberately.** The runner arrives at L5; a required activity nothing
  can grade makes its whole path permanently uncompletable. The seed refuses to finish if it finds
  one and the test asserts zero.
- **`requires_previous` throughout** — "steps so difficulties are in order", enforced in data.
- **Mixed grading by discipline**: UI/UX and the lead track use reviewed `scenario` activities
  with a rubric; the objective disciplines auto-grade.
- Answers are option INDEXES, not text: an author fixing a typo in an option must not silently
  invalidate every correct answer already recorded against it.

**Not yet true:** nobody is enrolled — these are department paths the head assigns, not mandatory
ones. No labs, no runner.

### lms `0.3.0` — L3 The HOD authoring surface (2026-08-25) — PROTOTYPED

"Later each HOD should make more" — the surface that makes it true. NO new backend: L1b already
had every endpoint, so this is the write layer and the pages.

**Added**
- `platform-ui/src/lib/lmsActions.ts` — createCourse / updateCourse / publish / retire, modules,
  activities, paths. The `ctx()` + `send()` shape every other actions file uses.
- `/learning/authoring` and `/learning/authoring/[courseId]`; `components/lms/CourseForm.tsx`,
  `AuthoringForms.tsx`, `LmsActionButton.tsx`; an Authoring nav row gated on `lms.authoring`.
- `getCourse(..., { includeAnswers: true })` — the authoring read, re-authorized for `update`.
- `e2e/lms-authoring.spec.ts` — 5 assertions driven against the rendered app, including the
  negative control (a plain member is refused and pointed at the catalogue).
- `lib/demoLms.ts` is now STATEFUL for authoring and implements fork-on-publish.

**Notes**
- **The authoring bound is not in this layer.** `resource_lms_course.yaml`'s `org_unit_lead` arm
  matches on server-resolved `unitAncestors`; the department select is a convenience. `can(me,
  "lms.authoring")` answers "may ask", never "may touch this course".
- **Every mutating action surfaces `versioned`.** Editing a published course forks a new draft,
  and an author who does not see that sentence believes they fixed live training and did not.
- **Publish and retire are `lms.publish`, not `lms.authoring`.** Publishing freezes what people
  will be certified against; retiring withdraws material somebody may be part-way through.
- **e2e locators are name-based, not `getByLabel`.** getByLabel substring-matches the accessible
  name, and "Title" collided with the course-key hint ("...it survives title changes..."). A
  locator that breaks when someone edits help text is a locator that will break.

**Not yet true:** attempt submission has no demo fixture and the lab runner does not exist (L5).
Path authoring has server actions but no page yet — paths are listed, not built, in the UI.

### lms `0.2.0` — L2 The general track and the training tenant (2026-08-25) — PROTOTYPED

The wave with the widest reach and no execution risk: content every employee takes, and the
isolated place ERP exercises are practised in.

**Added**
- `202608241550_lms_l2_general_track_and_training_tenant.sql` — `companies.is_training` with a
  partial unique index (at most ONE, ever), `lms_cohorts` / `lms_cohort_members`,
  `lms_training_reset_tables` (the allow-list, as DATA) and the append-only `lms_training_resets`.
- `src/seed/lms-general-track.ts` + `seed:lms-general-track` — three published courses and one
  mandatory path. Sixteen assessed questions.
- `src/modules/lms/mandatory-assignment.ts` + `lms:assign-mandatory` — the enrolment sweep,
  dry-run by default.
- `src/modules/lms/training-tenant-reset.ts` + `lms:reset-training` — the bounded reset. Dry-run
  by default; `--execute` additionally requires `--i-have-read-the-plan`.
- `src/modules/lms/spec-redaction.ts`, `spec-redaction.test.ts` (7), `lms-l2.db.test.ts` (16),
  and 4 new HTTP assertions in `lms-l1-acceptance.test.ts` (21 total).

**Fixed — both silent, neither would have thrown**
- **The quiz answer key was readable by every learner.** `GET /courses/:id` returned
  `lms_activities.spec` verbatim and `resource_lms_course.yaml` names `member` in its read rule
  deliberately. High scores on a mandatory track look exactly like training that works. Redacted
  by default now, stripped by FIELD NAME at any depth rather than by knowing each kind's shape —
  the kinds L5/L6 add are precisely what a shape-aware stripper would miss. `?includeAnswers=1`
  re-authorizes for `update`; a learner asking is refused rather than quietly redacted.
- **The training-tenant reset left the membership door open.** `revokeCohortAccess` deleted
  `company_memberships` under `withGlobal`, but that table carries FORCE RLS — zero rows, success
  reported. `user_roles` has no RLS, so the other half of the same function worked. Caught by an
  assertion that the REAL company's membership survived, not by anything failing.

**Notes**
- **Reset, not delete, and the bound is in the database.** 186 tables carry `tenant_id` and there
  is no hard-delete path for a company. The runner reads an allow-list table and NEVER derives one
  from `information_schema`; the tenant is resolved from `is_training` and cannot be passed in.
- **Per-table row counts, never a total.** A total hides the table that matched zero rows when it
  should have matched hundreds — which is how the RLS zero-row trap presents.
- **An unrecognised `applies_to` matches NOBODY.** 'unit' and 'discipline' arrive with L4; reading
  an unknown scope as "all" would enrol the whole company in one department's path.
- An employee with no `users` row is NAMED in the sweep output, never counted — a hole in
  coverage reported as a number is one nobody closes.

**Not yet true:** no company carries `is_training`, so the reset refuses outright; nothing is
deployed and `lms` is enabled on no live company.
### lms `0.1.0` — L1 Learning foundation (2026-08-24) — PROTOTYPED

The LMS the owner asked for: **all departments, all levels**, operational and management alike.
Its **own module key**, not filed under `hr` — filing a company-wide capability under one
department would have made Creative's or SEO's training silently depend on `hr` being served to
them. Design: `docs/blueprints/lms-foundation.md`.

**Added**
- `202608241322_module_lms_l1.sql` — 9 tables behind the `lms` third wall: `lms_courses`
  (versioned by `(course_key, version)`), `lms_modules`, `lms_activities` (polymorphic
  `read|watch|quiz|scenario|lab`), `lms_paths`, `lms_path_courses`, `lms_enrollments`,
  `lms_progress`, `lms_attempts`, `lms_completions`.
- `cerbos/policies/resource_lms_course.yaml` + `resource_lms_enrollment.yaml`;
  `202608241340_iam_lms_l1_permissions.sql` — `lms_staff`/`lms_manager` roles, 12 permissions,
  68 bundle rows. See `docs/PERMISSION-CONTRACT.md`.
- `src/modules/lms/` — catalogue + learn controllers, 5 rollup metrics, 3 read-only MCP tools,
  `lms-l1-acceptance.test.ts` (20 assertions over `buildApp()` + `app.inject()`).
- **platform-ui (L1c):** `/learning`, `/learning/catalogue`, `/learning/courses/[id]`,
  `/learning/compliance`, a `/me/learning` tab, `lib/lms.ts`, 7 mirrored capabilities in
  `lib/rbac.ts`, a `learning` mortarboard icon, `lib/demoLms.ts` fixtures,
  `src/lib/lms-readers.test.ts` and `e2e/lms-learning.spec.ts` (6/6 driven against the rendered
  app under DEMO_MODE).

**Fixed**
- **`lib/lms.ts` called `platformFetch(userId, path)` — arguments swapped — in every reader.**
  Both parameters are `string`, so `tsc` and 3,110 vitest assertions all passed while the LMS
  paths were never requested: the demo catch-all answered `[]` and the catalogue rendered
  "nothing published yet". A confident wrong answer with nothing thrown — the frontend-first
  drift class this repo keeps getting bitten by. Caught only by driving the rendered page;
  `lms-readers.test.ts` now runs each reader against the fixture store and asserts CONTENT, so
  a wrong path fails instead of degrading.
- `gradeAttempt` never passed `unitAncestors` to Cerbos, so every department head 403'd on
  grading — the derived role could not resolve.

**Notes**
- **Editing a PUBLISHED course forks a new version** rather than rewriting it. A completion points
  at the exact material that was assessed — the same freeze discipline as a payslip.
- **A waiver is not a completion**, and a path with zero required courses reports NULL, not 100%.
- **One dual-scope call in the whole module** (`{ modules: ["lms", "hr"] }`), for the certification
  write onto the employee's HR file. Every other query declares `["lms"]` alone.
- `lab` activities share the row shape but have no runner yet (L5/L6, the owner's SumoPod VPS).
  Theory does not wait on the sandbox.

**Not yet true:** nothing LMS is deployed, and the `lms` module is **not enabled on any live
company**. No content exists — the mandatory general track is L2, HOD authoring L3, the Web Dev
curriculum L4.

### finance `0.8.0` - F2 Posting Rules (2026-08-24) - PROTOTYPED

The seam other departments post through. **Business modules emit events in their own vocabulary;
finance owns the mapping to accounts.**

**Added**
- `202608241027_finance_posting_rules.sql` - `finance_posting_rules` + rule lines,
  `finance_ledger_events` (the inbox), `finance_process_event()`,
  `finance_process_pending_events()`, `finance_event_backlog()`.
- `202608241028_iam_finance_f2_posting_rule_permissions.sql` +
  `resource_finance_posting_rule.yaml` - 4 keys. See `docs/PERMISSION-CONTRACT.md` section 24.
- `src/db/finance-f2-posting-rules.test.ts` - 16 tests.

**Notes**
- **There is no expression language, and that is the most important decision here.** A rule line
  takes an amount from a NAMED PATH in the payload times an optional fixed multiplier. Nothing else.
  The moment a rule can compute, the chart of accounts becomes a programming language with no
  debugger, no tests and no review - and "why did this post there?" stops having a short answer. If
  a mapping needs logic, the emitting module computes the number and puts it in the payload, where
  it is ordinary code with ordinary tests.
- **Adds no second way into the ledger.** `finance_process_event()` builds a line array and hands it
  to `finance_post_journal()`, so balance validation, period guards, account guards, the hash chain
  and idempotency all apply unchanged. Pinned by tests: an unbalanced rule and a locked period both
  fail through F1's own errors.
- **Accounts are named BY CODE, resolved at post time.** A stored account id would keep posting
  silently after an accountant re-codes an account; a code breaks loudly, which is the correct
  failure. Pinned by test.
- **A failed event stays VISIBLE with its reason.** Unposted revenue is the thing nobody notices -
  the books simply look smaller and everything still reconciles. Each event is swept in its own
  subtransaction so one bad event cannot roll back the batch AND so its failure record survives.
- `RULE_NOT_EFFECTIVE` is distinguished from `NO_ACTIVE_RULE`. The first draft reported both as "no
  active rule", which the test suite hit immediately: a rule created today cannot post an event
  dated in February, and the message named a rule that was sitting there plainly active.

### finance `0.7.0` - F7 Tax and Statutory (2026-08-24) - PROTOTYPED

F4 and F5 already recorded the tax. F7 turns it into returns.

**Added**
- `202608241025_finance_tax_and_returns.sql` - `finance_tax_codes` (rate + base multiplier,
  effective-dated), `finance_tax_returns` (filing record with as-filed snapshots),
  `finance_coretax_extracts`; `finance_tax_compute()`, `finance_tax_ppn_summary()`,
  `finance_tax_pph_summary()`, `finance_tax_efaktur_exceptions()`,
  `finance_tax_coretax_reconcile()`.
- `202608241026_iam_finance_f7_tax_permissions.sql` + `resource_finance_tax.yaml` - 4 keys.
  See `docs/PERMISSION-CONTRACT.md` section 23.
- `src/db/finance-f7-tax.test.ts` - 14 tests.

**Notes**
- **Input VAT with no e-Faktur is NOT creditable** - the rule with a direct money consequence. It is
  EXCLUDED from the claim and reported separately rather than silently netted: the company pays it
  and cannot reclaim it, so the amount lost has to be visible while somebody can still chase the
  vendor for the faktur.
- **A single `rate` column cannot express Indonesian PPN.** Since 2025-01-01 the statutory rate is
  12% applied to ELEVEN TWELFTHS of the base - an effective 11%. Storing "11%" loses what the tax
  office cares about; storing "12%" alone overstates by ~9%. Codes carry `rate` AND
  `base_multiplier`, and are effective-dated so a 2024 supply keeps its full-base 11%.
- **`finance_tax_efaktur_exceptions()` reports two kinds, deliberately not merged.**
  `AR_MISSING_EFAKTUR` is a compliance failure (the customer cannot credit it either);
  `AP_INPUT_VAT_LOST` is a money loss. Same symptom, opposite consequence, different person to
  chase.
- **A return snapshots its figures AS FILED.** A late invoice booked after filing moves the live
  figure; the filed figure must not move, because an auditor asks about exactly that gap. Pinned by
  test.
- **Transmission to Coretax is NOT built and must not be** (blueprint section 6, D-F2 carve-out) -
  that goes through a licensed ASP/PJAP. What F7 owns is the harder half: correct tax data, and the
  monthly reconciliation between our ledger and DJP's pre-populated extract.

### finance `0.6.0` - F6 Bank Reconciliation and the Close (2026-08-24) - PROTOTYPED

**Added**
- `202608241023_finance_bank_and_close.sql` - bank statements, transaction lines, statement/ledger
  matches; `finance_bank_automatch()`, `finance_bank_reconcile()`, and
  **`finance_period_close_readiness()`** - the capstone that aggregates F1 ledger integrity, F3
  statement balance, F4/F5 subledger tie-outs, F6 bank reconciliation and the D-F5 sign-off into one
  answer.
- `202608241024_iam_finance_f6_bank_permissions.sql` + `resource_finance_bank.yaml` - 4 keys.
  See `docs/PERMISSION-CONTRACT.md` section 22.
- `src/db/finance-f6-bank-close.test.ts` - 13 tests.

**Notes**
- **The auto-matcher is deliberately conservative.** It matches only on an exact amount + direction
  + near-date triple, and REFUSES to match where two ledger lines are equally plausible. An
  aggressive matcher clears the queue and produces a reconciliation that looks complete while
  pairing the wrong payment with the wrong invoice - surfacing months later as a customer chasing
  money we recorded against someone else. An unmatched item costs a minute; a wrong match costs a
  relationship and an audit finding.
- **There is no plug.** `finance_bank_reconcile()` reports a position - GL balance, statement
  balance, each class of item in flight, and the unexplained residue. No adjustment field exists,
  because a difference nobody can explain is the finding.
- **The statement is never edited to match the ledger.** No function updates a transaction row. The
  test proves the right way to clear an unrecorded bank charge is to POST it.
- `finance_period_close_readiness()` does NOT close anything. It says whether you should; F0's state
  machine still governs who may, and still refuses OPEN -> HARD_LOCK and an unsigned hard lock.
- **Bank feed / API import is not included.** Lines arrive as data; the source (CSV, OFX, API) is an
  integration concern with its own credentials and changes none of the reconciliation logic.

### finance `0.5.0` - F5 Accounts Payable (2026-08-24) - PROTOTYPED

The mirror of F4, plus Indonesian withholding tax.

**Added**
- `202608241021_finance_ap_subledger.sql` - vendors, bills + lines (input VAT per line, withholding
  at bill level), payments, allocations; `finance_ap_approve_bill()`, `finance_ap_record_payment()`,
  `finance_ap_allocate()`, `finance_ap_aging()`, `finance_ap_position()`, `finance_ap_reconcile()`.
- `202608241022_iam_finance_f5_ap_permissions.sql` + `resource_finance_ap.yaml` - 6 keys.
  See `docs/PERMISSION-CONTRACT.md` section 21.
- `src/db/finance-f5-ap.test.ts` - 14 tests.

**Notes**
- **Withholding is the thing AP has that AR does not.** On a 100m services bill with PPh 23 at 2%:
  the expense is 100m, the VENDOR is owed 98m, and DJP is owed 2m. Two real liabilities, different
  creditors, different due dates. Booked at BILL APPROVAL, not at payment - the liability to DJP
  arises when the expense is recognised, and it keeps `amount_payable` equal to what the vendor is
  actually owed, which is what the aging must show. An aging listing gross bills overstates the cash
  that will leave.
- Allocation is capped at `amount_payable`, never `total`: the withheld tax was never the vendor's
  to be paid, and allocating against the gross would let a payment "overpay" by the withholding.
- **The reconciliation identity was reused from F4, second term and all** - open bills minus
  payments on account = control balance. F4's suite had to discover that; this one pinned it from
  the start, and the AP tests exercise a genuine vendor prepayment to prove it.
- `npwp` on a vendor is load-bearing, not decorative: its absence changes the withholding rate under
  Indonesian rules.
- **3-way matching (PO / goods receipt / bill) is NOT included.** It needs a purchase order and a
  goods-receipt document and there is no procurement module - a "match" against documents that do
  not exist would be theatre. Recorded as a dependency.

### finance `0.4.0` — F4 Accounts Receivable (2026-08-24) · PROTOTYPED

The first subledger. Schema + functions only.

**Added**
- `202608241019_finance_ar_subledger.sql` — customers, invoices + lines (tax as data per line),
  receipts, allocations; `finance_ar_issue_invoice()` (DR AR control / CR revenue / CR PPN
  Keluaran), `finance_ar_record_receipt()`, `finance_ar_allocate()`, `finance_ar_aging()`,
  `finance_ar_position()`, and `finance_ar_reconcile()` — the subledger-to-GL tie-out.
- `202608241020_iam_finance_f4_ar_permissions.sql` + `resource_finance_ar.yaml` — 6 keys, actions
  mapped onto SoD duties. See `docs/PERMISSION-CONTRACT.md` §20.
- `src/db/finance-f4-ar.test.ts` — 16 tests, reconciliation asserted empty after every state change.

**Changed**
- `202608241015` — `finance_post_journal()` gains `p_subledger`. Control accounts stay barred to
  manual journals, but the subledger that OWNS one may post to it. Deliberately narrow: it unlocks
  only control accounts whose `control_subledger` matches, so an AR posting is still refused on the
  AP control account.

**Notes**
- ⚠ **The reconciliation identity is NOT "open invoices == control account".** The test suite caught
  that on its first run. A receipt credits AR the moment the money lands, before allocation, so a
  customer who prepays leaves a credit inside the control account. The identity is
  **open invoices − payments on account = control balance**, exposed by `finance_ar_position()` so
  no caller re-derives it differently. The naive version reports a mismatch on every prepayment,
  which teaches people to ignore the reconciliation — the exact failure it exists to prevent.
- **Aging buckets by DAYS OVERDUE, not invoice age.** An invoice on 60-day terms issued 45 days ago
  is current; ageing by issue date makes a healthy book look distressed.
- **Allocation posts no journal.** The money moved when the receipt was recorded; allocation only
  says which debt it settles. Asserted by counting journal entries before and after.
- **Credit limits, dunning and credit memos are NOT included** — policy layers on top of a working
  subledger. `credit_limit` is stored but deliberately unread; a silently unchecked limit is worse
  than an absent one.

### finance `0.3.0` — F3 Statements (2026-08-24) · PROTOTYPED

**The phase project-hug never reached.** Its `FINANCE_PHASE_ROADMAP.md` §8 is entirely unchecked,
including its own "Total Assets must equal Liabilities + Equity" checkpoint — so this was walked
from first principles and verified by test.

**Added**
- `202608241017_finance_statements.sql` — `finance_account_movement()` (the shared engine, so no two
  statements can disagree about what a balance is), `finance_trial_balance()`,
  `finance_general_ledger()` with a continuous running balance and correct opening balance,
  `finance_profit_and_loss()`, `finance_net_profit()`, `finance_balance_sheet()`, and
  `finance_verify_statements()` (one row per problem; empty = pass).
- `202608241018_iam_finance_f3_statement_permissions.sql` + `resource_finance_statement.yaml` — the
  `finance_statement` kind, `read` + `export`. See `docs/PERMISSION-CONTRACT.md` §19.
- `src/db/finance-f3-statements.test.ts` — 13 tests, including A = L + E surviving a reversal.

**Notes**
- **A = L + E only holds because current-period profit is carried into equity.** Revenue and expense
  are temporary accounts that close into retained earnings at year end; before that close their net
  is still equity, just unmoved. Omit it and the sheet is out by exactly the year-to-date profit.
  `p_fy_start` is therefore a required argument, not a defaulted one — "profit so far" is meaningless
  without knowing when the year began, and not every company's year starts in January.
- **Contra accounts derive their sign from `normal_balance`, never from a hardcoded code list.**
  Both directions are pinned: a sales return (revenue/debit-normal) nets negative against revenue,
  and accumulated amortisation (asset/credit-normal) presents negative under assets.
- **Reversed entries are NOT excluded from statements.** A reversed entry and its reversal both
  appear and net to zero — the auditable answer. Filtering them would disagree with the trial
  balance and hide a correction.
- **Implemented as functions over the ledger, not materialised projections.** A projection can drift
  from the ledger (a whole failure class project-hug needed an integrity service to manage); an
  aggregation cannot, because it IS the ledger. The signatures are what must stay stable — the
  projection can land behind them when measurement calls for it, and these tests become the oracle
  proving it agrees.
- **Cash Flow is deliberately NOT included.** The indirect method needs each account classified as
  operating/investing/financing — CoA metadata that does not exist yet. Inventing it inside a query
  would hide a modelling decision; it gets its own ticket.

### finance `0.2.0` — F1 Ledger Core (2026-08-24) · PROTOTYPED

The book of record. Schema + functions only — still no HTTP surface, no statements (F3), no
subledgers (F4/F5).

**Added**
- `202608241015_finance_ledger_core.sql` — `finance_journal_entries` / `_lines` /
  `_line_dimensions`, immutable by trigger; `finance_post_journal()` (the one way in — idempotent on
  `source_event_id`, totals computed FROM the lines, per-company advisory lock so the sequence and
  hash chain cannot fork); `finance_reverse_journal()` (correction is a mirrored entry, never an
  edit); `finance_verify_ledger_chain()` (returns one row per PROBLEM — an empty result is the pass
  condition); SHA-256 chain with one canonical serialisation shared by writer and verifier.
- `202608241016_iam_finance_f1_ledger_permissions.sql` + `resource_finance_ledger.yaml` — 4 keys on
  the new `finance_ledger` kind, role-arm only. See `docs/PERMISSION-CONTRACT.md` §18.
- `src/db/finance-f1-ledger.test.ts` — 25 tests through the NOBYPASSRLS app role.

**Changed**
- `202608241011` CoA seed: **bank, cash and tax accounts are no longer flagged as control
  accounts.** Control means "reconciled against a subledger that POSTS INTO IT" (AR, AP, inventory,
  fixed assets), not "reconciled" in general — bank and cash reconcile against a *statement*.
  Driving the first real posting rejected a rent payment from `1120 Bank`, which was the correct
  behaviour for the flag and the wrong flag for the account. 16 control accounts → 5.

**Notes**
- The reversal link points FORWARD ONLY (`reversal_of_id` on the reversing entry). A `reversed_by_id`
  on the original would require updating a posted journal — the exact thing the table forbids — so
  status is derived via `finance_journal_entry_status()`. `finance_reverse_journal()` performs zero
  updates on the ledger.
- The immutability trigger's entries-only column check had to be NESTED, not a flat AND-chain:
  plpgsql resolves `OLD` against the triggering table, so `OLD.entry_hash` raised
  `record "old" has no field "entry_hash"` when firing on lines. Still fail-closed, but surfacing as
  an internal error instead of the ledger's own message. Pinned by a regression test.

### finance `0.1.0` — F0 Foundations (2026-08-24) · PROTOTYPED

First code for the Finance & Accounting department. **Schema and authz only — nothing posts yet.**
Design: `docs/blueprints/finance-accounting-foundation.md`. Tracker:
`docs/plans/2026-08-24-finance-PROGRESS.md`.

**Added**
- `202608241010_finance_ownership_and_scope.sql` — `company_ownership` graph + the scope resolver
  (`finance_owner_company_ids`, cycle-guarded `finance_company_descendants`) implementing owner
  ruling D-F8: a holding owner reaches every descendant, a company shareholder reaches only their
  own company. Establishes the `finance` third wall.
- `202608241011_finance_coa_and_dimensions.sql` — chart of accounts as **editable data** (ruling
  D-F5) with a 69-line PSAK-aligned Indonesian template incl. PPN Masukan/Keluaran and PPh
  21/23/4(2); accounting dimensions with per-account `required/optional/forbidden` rules; a freeze
  trigger making an account's code/type/normal-balance immutable once posted.
- `202608241012_finance_fiscal_calendar_and_currency.sql` — fiscal calendar with the
  `OPEN → SOFT_LOCK → HARD_LOCK` state machine (HARD_LOCK terminal; refuses without a named
  accountant sign-off), currencies, exchange rates carrying their `basis` (spot/closing/average),
  and `finance_period_accepts_posting()`.
- `202608241013_finance_sod_and_elevation.sql` — 12 finance duties and the 6 blocking
  segregation-of-duties pairs; elevation grants that cannot be approved without an expiry and lapse
  on their own; append-only finance access log.
- `202608241014_iam_finance_f0_permissions.sql` — 13 grantable permissions across 3 new Cerbos kinds
  (`finance_config` / `finance_period` / `finance_control`), the `finance_staff` / `finance_manager`
  roles, and 48 generated bundle rows. Role-arm only, no `perm_*` mirror. See
  `docs/PERMISSION-CONTRACT.md` §17.
- `cerbos/policies/resource_finance_{config,period,control}.yaml`.
- `src/db/finance-f0-foundations.test.ts` — 35 tests through the NOBYPASSRLS app role.

**Notes**
- The scope resolvers are `SECURITY DEFINER` **by necessity**: they read tenant-walled tables in
  order to COMPUTE the tenant set, so as INVOKER they returned the empty set for everyone —
  including the holding owner — silently. Caught by the test suite on its first run.
- Four new authoring groups in `permission-groups.json`; pinned tallies updated in
  `cerbos-catalog-alignment`, `permission-groups-catalog-parity`, `iam-215-boundary-pin` and
  `ui-grantable-catalog` (320/81 → 333/84 pairs/kinds, 305 → 318 grantable).
- **No handlers, endpoints or UI.** F1 (ledger core) is the next phase; the IAM arm is deliberately
  role-arm only until those handlers exist and their holders are audited.

### hr `0.4.0` + platform-nest `0.38.0` + platform-ui `0.49.0` — 2026-08-24 — HR-FULL: the department, waves A–D

**Status: MIXED, and the mix is the point.** Schema/RLS and the pure engines are **DEV-VERIFIED**;
handlers and UI are **PROTOTYPED**. See the per-layer table in
[`MODULES.md`](./MODULES.md#hr--people--hiring--pay--040--in-progress) — nothing here was driven
end-to-end against a running stack, and "the unit suite is green" is not that.

Owner ask (2026-08-24): finish the HR department — research the best HR ERPs, find what was not yet
planned, and build it. Scope confirmed as all four waves **including payroll**, and PII posture
confirmed as label-only per 0109's precedent.

**What the audit found.** `docs/blueprints/hr-department-foundation.md` §3 listed seven candidate
capabilities. Measured against the standard HCM capability map, **five more gaps existed that the
blueprint did not name at all** — and they were the load-bearing ones:

- `hr_leave_balances.allocated_minutes` had **nothing that computed it**. It was a number somebody
  typed, and nothing in the system could restate how it was reached.
- **There was no holiday calendar.** A five-calendar-day leave request spanning a weekend was charged
  as five days.
- `employees` held CURRENT state only, so every promotion, transfer and status change **OVERWROTE the
  previous fact**. Tenure, turnover and any statutory severance calculation were unanswerable from
  the database.
- `hr_records` had no validity. **An expired work permit and a current one were byte-identical to
  every query in the system.**
- Nothing modelled what anyone is paid.

#### Added

- **33 tables across four migrations** (`202608240140`–`0143`), every one behind the byte-identical
  0028 third-wall predicate, applied through the same DO-loop shape so it cannot drift per table.
  - **A** — holiday calendars (with Indonesian *cuti bersama*, which is not worked but IS charged —
    two facts that needed two counters), leave policies + assignments + an append-only accrual ledger,
    `hr_job_events` (the effective-dated worker history), document expiry + a reminder ledger, review
    cycles + participants, and an append-only case timeline.
  - **B** — the ATS. `hr_candidates` is a population **deliberately separate from `employees`**:
    different legal basis, its own retention clock, and nothing that provisions access may reach it.
    Hiring is an explicit CONVERSION, and `ck_hr_offer_conversion` makes "converted ⟺ has an
    employee_id" a database invariant rather than a convention.
  - **C** — pay grades, effective-dated compensation, allowances, BPJS enrolment, PPh 21 tax profiles.
  - **D** — statutory parameter sets, payroll runs, frozen payslips + itemized lines, per-period
    inputs, separations.
- **Four pure engines**, no database and no clock: `working-days.ts`, `leave-accrual.ts`,
  `payroll-calc.ts` (PPh 21 TER + progressive reconciliation + BPJS + THR), `severance.ts`
  (PP 35/2021's three components). **109 unit tests.**
- **Three Cerbos kinds** — `hr_policy` (read deliberately WIDE), `hr_recruitment` (wider than
  `hr_case` on read, narrower on write, with an attribute-gated panel arm), `hr_payroll` (a step
  ABOVE `hr_record`) — plus 18 catalog permissions, 11 authoring groups, role bundles, and migration
  `202608240144`.
- **Four controllers**, eight read-only MCP tools, five new rollup metrics, seven console pages and
  `/me/pay`.

#### Fixed / corrected

- **`app_module_allowed()` returns NULL, not `false`, on an unset GUC.** 0028's header says "false".
  Verified against a live Postgres. The wall is unaffected (RLS admits only TRUE), but anything
  OUTSIDE a policy is affected — `IF NOT app_module_allowed(...)` never fires on NULL. Corrected in
  `202608240140`'s header and pinned by the test as NOT-TRUE rather than as false.
- **Four Cerbos resource attributes were silently dropped.** `resourcePayload()` in `cerbos.ts` is an
  explicit allow-list, and `published` / `panelistUserIds` / `hiringManagerUserId` /
  `recruiterUserId` were not in it. Two of them arrive through an object spread, where TypeScript's
  excess-property check does not fire — so the type alone would not have caught it, and every
  panelist would have been denied for no visible reason.
- **Seeding `member` was tried as an exclusion and reverted.** Omitting `member`'s self/panel-scoped
  bundle rows broke `role-permission-parity.db.test.ts`, correctly: Cerbos genuinely grants them. The
  safety argument is the ABSENT `perm_*` mirror, not an absent row — which is exactly what 0094
  already established for `hr_case`.

#### Caught by the FULL suite, after the touched-file suites were already green

Recorded because it is the argument for the whole gate. Three failures, none in an HR suite:

- **Cerbos had not reloaded** the three new policy files, so the live PDP denied all 18 new keys
  (`authz-permissions.controller.test.ts`). Restarted, then **probed with real decisions** rather
  than trusting health: own PUBLISHED payslip ALLOW / own DRAFT DENY / another's DENY; panelist
  read+create ALLOW but update+delete DENY; non-panelist all DENY; hiring manager read+update ALLOW
  but approve DENY; member on `hr_policy` read ALLOW but update+ratify DENY.
- **A real routing regression** (`override-request-decide.test.ts`). `routeFor()` counts a role's
  sensitive, non-self-scoped HR permissions to pick an override approver; `member`'s three
  panel-gated `hr_recruitment` keys were unmarked, so a NON-HR override began routing to hr_manager
  instead of company_admin. Two causes: the panel conditions had been factored into
  `variables.local`, making them opaque to the self-scope classifier, and the classifier had no
  vocabulary for membership (`principal.id in attr.X`) regardless. Fixed by inlining the conditions
  and teaching both twin predicates the membership form — blast radius measured first: that form
  appears in exactly ONE resource policy, so no pre-existing role's classification moved.
- **`CAPABILITY-INVENTORY.md` drifted** once 8 MCP tools were added. Regenerated.

⚠ An earlier draft of this entry called the marker gap "not exploitable — the ceiling governs
granting, not acting." **That was wrong** — the marker also feeds override routing. Corrected rather
than deleted, because the wrong reasoning is the useful part.

#### The acceptance drive (added after the first pass, and it found two things)

`src/modules/hr/hr-full-acceptance.test.ts` — the whole department over REAL HTTP (`buildApp()` +
`app.inject()`, live Postgres + live Cerbos), following one employee end to end: configure →
requisition → candidate → interview → scorecard → offer → convert → payroll
calculate/ratify/approve/publish/pay → the subject reads their OWN published payslip → accrue leave →
separate → analytics. **19 assertions, 0 skips.** Handlers move PROTOTYPED → DEV-VERIFIED.

Two findings, both in the TEST rather than the code, and both worth recording because a green run
would have hidden them:

- **The fixture conflated the panelist with the hiring manager.** One user held both roles, so the
  hiring-manager rule granted `update` and the assertion "a panelist cannot reject a candidate"
  passed against the wrong rule — proving nothing. Split into two users; the panel arm and the
  hiring-manager arm are now proven separately.
- **The test's own arithmetic was wrong** on service years (asserted 1.75 for a 2026-10-01 →
  2027-06-30 span, which is nine months). The engine said 0.746 and the engine was right.

#### Seeding — `npm run seed:hr-config`

Holiday calendar (Indonesian 2026 incl. *cuti bersama*), three leave policies encoding UU 13/2003
art. 79, the 9-stage funnel, 7 pay grades, 6 allowance types, all five BPJS programs as SEPARATE
plans, and an UNRATIFIED statutory parameter set. Idempotent (proven to a third run) and asserted to
write **zero personal data** — which is what lets it run pre-Gate-1.

#### DEPLOYED — `alpha-01.071.0150a`, 2026-08-24 10:05 UTC

Live on `erp.gaiada.online`. Evidence from the deploy job's own log, not from the green tick:

- **6 database backups taken BEFORE any migration** (gaiada_platform, knowledge, keycloak, n8n, bot,
  waha-sessions).
- **All five migrations applied to the live database:** `202608240140_hr_time_and_lifecycle`,
  `…0141_hr_recruitment`, `…0142_hr_compensation_benefits`, `…0143_hr_payroll`,
  `…0144_iam_hr_full_permissions`.
- **Cerbos went `Restarting` and came back healthy** — it recompiles its whole policy repo at
  startup, so that transition IS the three new resource policies loading on the live PDP. The health
  gate now uses `ps -a`, so the crash loop this program hid once before would have been caught.
- `all services healthy` after the wait.

#### SEEDED on live — 2026-08-24

`seed:hr-config` run against the live database. Surveyed BEFORE (all eight config tables at zero;
23 employees / 41 records / 39 cases / 17 leave requests already present) and verified AFTER **as
superuser**, independently of the seed's own read — because a seed that reports success having
written nothing is this program's signature failure, and its own count is not evidence.

| | before | after |
|---|---|---|
| holiday calendar / holidays | 0 / 0 | 1 / 17 (15 public + 2 *cuti bersama*, both `deducts=true`) |
| leave policies / assignments | 0 / 0 | 3 / 3 |
| pipeline stages | 0 | 9 |
| pay grades · allowance types · benefit plans | 0 · 0 · 0 | 7 · 6 · 5 |
| statutory set / parameters | 0 / 0 | 1 / 24 |
| **employees · records · cases · leave** | **23 · 41 · 39 · 17** | **23 · 41 · 39 · 17 (untouched)** |
| candidates · compensation · payslips · requisitions | 0 | 0 (zero personal data written) |

The vacation policy landed as `upfront / 5760min / wait=12mo` — UU 13/2003 art. 79. Sick and unpaid
are `none`, because Indonesian sick leave is a paid-wage rule and not a counted entitlement.

**Idempotence proven ON LIVE, not just in a test:** a second run created nothing (`existing=` for
every section) and every count was identical afterwards. That matters because this seed will re-run
on future deploys.

**The statutory set is UNRATIFIED** (`ratified_by=NULL`), confirmed by direct query. Payroll
calculates against it and refuses to finalize without a recorded override.

⚠ **A concurrent session's release commit swept this work in.** `c4f6198` is titled for that
session's agent/bot changes but contains all 59 HR-FULL files. The tag `alpha-01.071.0150a` is
therefore accurate about the code and misleading about the subject — worth knowing when reading the
history. `docs-map` went red on it (MAP.md is filesystem-derived and was not regenerated); fixed in
`c22ea0e`.

#### Flagged, not resolved

1. **The statutory set is UNRATIFIED on live.** Payroll calculates but refuses to finalize without a
   recorded override. Finance/counsel ratifies in-app from `/hr/settings` (company admin, high
   assurance) once the PPh 21 / BPJS / PTKP figures are confirmed.
3. **The statutory figures are UNRATIFIED.** They express the structure of PP 58/2023 and PP 35/2021
   and are not legal advice. The engine hard-codes nothing, every run records the set it used, and
   finalizing against an unratified set demands a permanently-recorded override — that is the
   employee-portal §6 gate, re-expressed as data so the engine could be built without waiting on it.
4. **Payroll sequencing overrides a written plan.** `employee-portal-foundation.md` §6 assigned the
   engine elsewhere. Owner-directed, recorded in the migration header rather than left for a future
   reader to discover as a contradiction.
5. **No seeds** for calendars, policies, pipeline stages or a parameter set. Every affected surface
   renders an empty state that says what is missing instead of inventing a default.
6. **The `HR` nav entry remains ungated**, predating this work. The two money tabs are
   capability-gated inside the console, so this does not widen it.

### platform-nest `0.37.0` + platform-ui `0.48.0` — 2026-08-24 — client-centric ERP, slice 1: the client hub + the `clientId` facet (CC-01..03)

**Status: DEV-VERIFIED** (browser-driven against a DEMO_MODE build; the SQL additionally validated
against the LIVE estate before deploy). Design: `docs/plans/2026-08-24-client-centric-erp-design.md`.
Contract: `docs/FRONTEND-BFF-CONTRACT.md` §22.

Owner ask: read the ERP client-first — tasks, projects and everything else shown and filtered to the
client. The measurement that shaped the design: **`client_id` is already on 12 tables, so no new
columns were needed** — what was missing was the read surface. And **26 of 71 tasks / 9 of 20 projects
have no client at all**, so "everything starts with a client" needed an explicit answer for the
clientless third of the estate rather than a filter that quietly loses it.

**The finding worth keeping:** the client portal has always shown a client everything they own on one
surface, while `/clients/[id]` on the staff side showed contacts and a calendar and none of the
client's work — **staff had a worse client-centric view than the client did.** This slice is the staff
mirror of `/portal`.

#### Added
- **`core/client-filter.ts`** — the `?clientId=` facet: absent / `<uuid>` / `internal`. `internal`
  resolves to `client_id IS NULL`, **not** `is_internal = true`: the two disagree on the live estate
  (9 clientless projects, 7 flagged) and keying on the flag would leave 2 projects reachable from no
  scope at all.
- **Facet on `GET /projects`, `GET /pm/tasks`, `GET /invoices`** — all additive; omitting the
  parameter is unchanged behaviour. The task facet joins through `projects` (no `pm_tasks.client_id`,
  by decision) and turned out cheaper than designed: that CTE already joins `projects`.
- **`GET /:t/clients/:clientId/overview`** — the hub aggregate, one round trip, mirroring
  `/portal/overview`. Carries **`needsUs`** alongside `needsClient`.
- **`/clients/[id]` hub** — Overview + Work tabs, tab strip, `clientHub.css`. The former client page
  moved verbatim to `/clients/[id]/details`; nothing was deleted.

#### Fixed
- The client page fetched **every project in the tenant** and narrowed in the browser — which stops
  being a filter past one page of rows. Now server-side.

#### Notes / non-obvious
- **The facet is a CONVENIENCE FILTER, not a boundary, and both files now say so pointing at each
  other.** `portal-scope.ts` fails CLOSED (an external client must not reach another's rows); this
  fails OPEN (a bad value shows everything), because a filter that fails closed hides real work and
  looks exactly like "there is nothing here". Merging them into one "client scope" abstraction is how
  a filter silently becomes load-bearing for isolation — pinned by a unit test that says so.
- **`needsUs` is the reason the aggregate exists.** Nothing in the ERP rendered it before, which is
  precisely how a client-recorded payment sat `pending` with no screen saying anyone had to confirm
  it. Verified on the live estate: Nusa Coffee Co has **2** items waiting on us (an IDR 10,000,000
  payment awaiting confirmation, one untriaged change request) against 7 waiting on the client.
- The aggregate runs with `{ modules: ["social"] }`: the post-review join carries the `social` third
  wall and without the scope that SELECT returns **zero rows and raises nothing** — the hub would have
  reported "no post reviews outstanding" for a client with ten.
- Unlike the portal layout, the hub layout lets a fetch failure **throw**. A hub rendering zeroes tells
  a manager their client has no work, nothing owed and nobody waiting; this is the screen people act
  on, so an empty state must mean "empty", never "we could not ask".
- Demo fixtures mirror the facet, `internal` included. A fixture that ignored `?clientId=` would make
  every client-scoped surface look right in DEMO_MODE while showing the whole tenant — and would have
  lit up the Work tab's data-integrity card with other clients' tasks.

#### Known gaps (tracked, not implicit)
- The **six endpoints that already had `clientId`** (`deliverables`, `contracts`, `pipeline/runs`,
  `meetings/recordings`, `webdev/change-requests`, `social/*`) accept a uuid only — `internal` matches
  nothing there. Slice 2.
- **No facet yet** on `invoice-payments` or `time-entries`; **no `/approvals` list endpoint exists**.
- **Still no staff write UI** for contracts or payment confirmation (§16e). This slice makes both
  VISIBLE in `needsUs`; the Commercial tab that calls `send`/`countersign`/`decide` is slice 2.
- Slices 3-5 (Delivery / Requests / People tabs, the staff timeline, `<ClientPicker>` on the
  object-first lists) are PLANNED.

#### Gates
`tsc --noEmit` clean in both projects · `lint:withtenants` + `lint:migration-rls` OK · 9 unit tests
for the filter (incl. the fail-open contract) · **10 real-DB tests** for the facet and the money
math, run against a live test Postgres · platform-ui **172 files / 2795 tests** green ·
`DEMO_MODE=1 next build` green with all three hub routes · Playwright drove the hub in a browser.
No migration in this slice.

### platform-ui `0.53.0` — 2026-08-26 — GM console: the money tier (GM-09), and the block that dissolved

**Status: PROTOTYPED.** Driven in a browser against a DEMO_MODE build; not against live platform-nest.
Tracking: [`../plans/2026-08-24-gm-console-PROGRESS.md`](../plans/2026-08-24-gm-console-PROGRESS.md).

**GM-09 was blocked for the entire build, correctly, and then the ground moved.** The only money data
in the estate was `GET engagements/:id/ledger` — one department's search-marketing provider spend —
and OQ-3 forbade summing it into a company figure, so the money half shipped behind an honest
`BackendPending` banner. A real double-entry finance module then landed (`finance_profit_and_loss()`
in Postgres, Cerbos-authorized statements, AR/AP aging), and revenue and margin became available from
the BOOKS at exactly the grain the cockpit needed.

Worth stating plainly, because the temptation recurs: **had the engagement-ledger shortcut been
shipped, the console would now carry a figure that disagrees with the general ledger**, and the fix
would be a migration away from a number people had started quoting in reviews. A `BackendPending`
banner is not a stalling tactic — it is a position that stays correct while the estate changes.

- `lib/gmMoney.ts` — pure, 13 tests. Reads the P&L's own `TOTAL_REVENUE`/`TOTAL_EXPENSE`/`NET_PROFIT`
  rows rather than re-summing lines (re-summing would agree with the ledger only until the first
  contra-revenue account). Money parses at the edge and may fail to `null`; **never 0**, because "we
  earned nothing" is the most expensive wrong answer this surface can give. Margin on zero revenue is
  `null`, not 0% — undefined, not a value.
- `GmMoneyCard` — three states that must not look alike, behind the `listPeriods` gate read (the one
  finance reader that distinguishes 403 from 404): **forbidden** / **no fiscal calendar or module not
  enabled** / **real books**. Compact on the cockpit, full on the tab.
- Cockpit renders it **last**, below both operating tiers — the cadence rule this console follows puts
  financials at the end of the deck. It first shipped in the middle by mistake; the e2e ordering
  assertion caught it.
- New `finance.statement.view` + `finance.ar.view` capability mirrors, accepted by the 1151-pair
  parity guard.
- Owner rulings: money answers **"are we making money?"** first; **compose and link out** to
  `/finance`, never a second finance console; **active company only**.

**Findings carried out of this work**

1. **Three finance roles have no UI `Role` member.** `finance.statement.read` is held by
   `company_admin`, `finance_manager`, `finance_staff`, `owner`, `platform_admin` — but the middle
   three do not exist in `rbac.ts`'s union, so they resolve to **zero capabilities** across the whole
   app. Same defect class as that file's own Gap 1/2/3 comments. It affects the entire `/finance`
   console, not the GM tier, so it is reported rather than widened inside a GM ticket.
2. **DEMO_MODE modelled no finance authz whatever** — `financeDemo` did not take a `userId`, so a
   plain member was served the company's books. Fixed with a holder set returning **403**, not empty
   fixtures: `lib/finance.ts` deliberately distinguishes refusal from absence and empty fixtures would
   have destroyed that distinction. Third fixture-fidelity gap this session; worth treating as a
   pattern.
3. **`mode: "serial"` (added the day before) was the wrong fix** — it skips every later test in a group
   when one fails, so a single stale assertion reported "1 failed, 21 did not run" and hid the rest.
   Replaced with `fullyParallel: false` on the `gm` project: same single-worker sequencing, independent
   pass/fail.

### platform-ui `0.52.0` — 2026-08-25 — GM console: the narrowed department-lead view (GM-02b)

**Status: PROTOTYPED.** Driven in a browser against a DEMO_MODE build; not against live platform-nest.
Tracking doc: [`../plans/2026-08-24-gm-console-PROGRESS.md`](../plans/2026-08-24-gm-console-PROGRESS.md).

**The headline is a corrected assumption, not a feature.** GM-02b was parked as blocked: "the UI cannot
identify a department lead" — `Me` carries no position or leadership signal and the P2-05 reconciler is
unbuilt. All true, and all irrelevant. `reports.department.view`'s own declaration in `CAPABILITIES`
reads *"department-grain (Cerbos `read_department`) — **SERVER narrows to the led unit subtree**"*. The
console asks for department grain and Cerbos decides which units come back; determining leadership in
the browser would have been precisely the "second opinion" the mirror rule forbids. **The blocker was
created by reaching for the wrong mechanism.** Worth generalising: when a UI blocker is "we cannot
determine X about the principal", check whether the server already determines X and narrows for you.

- `lib/gm.ts` — `gmAccessFor` returns `full` / `narrowed` / `none`. Company tier checked FIRST, so a
  principal holding both capabilities is not narrowed by the more specific-sounding check. Still
  company-scoped, so a `manager` of one tenant cannot read another's departments by editing the URL.
- `GmCockpit` — a narrowed lead gets **no company read at all** (not requested, not
  requested-and-discarded: firing it would log a guaranteed 403 per page view and invite a future
  refactor to render whatever came back), a banner stating the absence, provenance sourced from
  whichever read answered, and the period toggle **relocated** onto the Departments card — it normally
  rides the company card, so without the move a narrowed reader would have no route to a month view
  except hand-editing the URL.
- `gmTab.tsx` — `companyGrainOnly` opt-in and a third refusal state. The Business Review uses it and
  refuses with its own wording; "limited to group executives" alone would imply the reader does not
  belong in the console at all when every other tab is theirs.
- New **manager-tier demo identity** (`manager@gaiada.com` -> `dept-manager`, exactly one `manager`
  grant) + a `manager` row in `e2e/personas.ts`. An authorization tier that cannot be driven is a tier
  nobody verifies — neither `demo-hansel` (full) nor `gede-ic` (refused) exercises this one.
- `demoReports.ts` — **the fixture denied department grain to every non-superadmin** (`elevated =
  userId === "demo-hansel"`), contradicting §8. Fixed *including the narrowing*: a `LED_UNITS` map means
  the manager sees one department where the GM sees five. All-or-nothing would have let the narrowed
  console look correct while never exercising the behaviour it is built on.
- e2e 18 -> **25 tests**, all green.

**Two deliberate expectation flips**, both recorded in their test bodies so neither reads as a
regression to "fix" back: `gm.test.ts`'s "refuses a department manager" became "admits a department
manager — narrowed", and the e2e `REFUSAL` regex tightened from `/limited to group executives/i` to the
denial's distinctive opening clause — the loose pattern matched the narrowed banner and the
company-only refusal too, since that phrase is the true boundary in all three cases. Three states need
three distinguishable strings.

**GM-09 (the money tier) is deliberately still blocked.** The only cost data in the estate is
per-engagement search-marketing spend, so a "group spend" endpoint built on it would produce exactly
the misleading figure OQ-3 ruled out. That is a **data** gap needing an owner ruling, not an
endpoint-writing chore; writing it first would move the ambiguity into the backend.

### platform-ui `0.51.0` - the cap table and accounting settings become editable (2026-08-25) - PROTOTYPED

**Added**
- `/finance/ownership` (UI-01c) and `/finance/settings` (UI-02b), `lib/financeActions.ts`,
  `components/finance/{OwnershipEditor,SettingsEditor}.tsx`, demo fixtures.

**Notes**
- ★ **`listOwnership` returns `null` on 403, never an empty list.** `finance_ownership:read` is a
  narrower grant than the rest of finance - a `finance_staff` clerk is denied outright - so a 403 is
  the COMMON case here. Folding it to `{edges:[],problems:[]}` would render "this company has no
  recorded owners", an active false statement about the cap table rather than a missing one.
- **`problems[]` renders beside the rows, not behind a tab.** A cap table totalling 85% or 140% has
  to say so where it is read; anywhere else and the common case - glance, believe it - shows a
  register that looks authoritative and is not.
- **`STAKE_INCOMPLETE` is a note, `STAKE_EXCEEDS_100` is a problem.** Same shape of data, different
  treatment: one is ignorance, the other is wrong. A partially-recorded cap table is the normal
  state of a real one.
- **Neither form re-validates a server rule.** The 15/16-digit NPWP check and the posted-VAT guard
  live in the database and their messages surface verbatim. A second copy drifts, and the copy that
  drifts is the one the user sees.
- **The settings page shows the fiscal year start read-only WITH the reason.** A field that exists
  and then fails is worse than one never offered: the field implies permission and the refusal
  arrives after the user has decided what they want.
- **Configuration links from the console, not the sidebar.** `nav.ts` renders exactly one Finance
  row on purpose; two more top-level rows would fight that dedupe.
- The demo cap table totals **85%**, deliberately, so the incomplete-table copy is reachable in a
  browser. A demo that adds up perfectly hides the reason the validation exists.

### finance `0.14.1` - FinanceErrorFilter no longer swallows other modules' database faults (2026-08-25) - PROTOTYPED

**Fixed**
- `finance-error.filter.ts` delegates a NON-`FINANCE_*` `DatabaseError` to
  `LastResortExceptionFilter` instead of answering in its place.
- `provider-dispatch-error.filter.test.ts` - `FinanceErrorFilter` added to the pinned filter order.
- `finance-error.filter.test.ts` - 5 tests, one of which is the regression guard.

**Notes**
- ★ **The bug was invisible by construction.** The filter is `@Catch(DatabaseError)`, so it
  intercepts EVERY pg error in the estate, not only finance's. It replied 500 with exactly the body
  `LastResortExceptionFilter` uses - but LastResort ALSO writes `[unhandled-exception]` to stderr
  and records the fault on the active OTel span. So every non-finance database fault became a
  SILENT 500: identical response, no log line, no trace. Nothing about the response could reveal it.
- Delegating keeps ONE implementation of "what do we do with an unhandled fault", so a later change
  there cannot drift from a copy hiding in the finance module.
- **The order-pin test was right to fail.** `provider-dispatch-error.filter.test.ts` asserts the
  EXACT registered filter list precisely so a filter added to `main.ts` cannot ship unreviewed. It
  caught this one. The fix records the addition and states why this filter's `@Catch` type is NOT
  disjoint from the others - it is the entry that needed reasoning about, which is what the test is
  for.

### finance `0.14.0` - F8 complete + F9 consolidation begins (2026-08-25) - PROTOTYPED

**Added**
- `202608251130` capitalisation, the depreciation run, the register/GL tie-out.
- `202608251230` disposal, impairment, deferred tax (PSAK 46), the close interlock.
- `202608251330` the fixed-asset movement schedule.
- `202608251430` intercompany tagging.
- `202608251530` control determination, the consolidation group, a SEPARATE consolidation ledger,
  and the first elimination.
- 45 tests across five suites.

**Notes**
- ★ **Tax depreciation is recorded and never posted.** Book depreciation is an entry in the books;
  tax depreciation is a figure on a computation. Posting both would give statements that look
  plausible and are wrong in a way no reconciliation could catch - both sides consistently wrong.
- ★ **Deferred tax ADJUSTS TO A TARGET**, it does not post the computed figure. Posting the figure
  each period accumulates it: by year three the sheet carries three times the real balance while
  every individual entry looks correct.
- ★ **Eliminations never touch an entity's books.** An elimination is true of the GROUP and false of
  the ENTITY. Posting one into a subsidiary would make its standalone statements and its tax return
  wrong, and leave an auditor looking at entries with no supporting transaction.
- **The intercompany counterparty lives on the ACCOUNT, not the journal** - the ledger is immutable,
  so a journal tag could only be set at posting time via a 13th parameter on a 313-line function
  with seven callers. An account must be CHOSEN, so a mis-posted related-party balance is visible.
- **Two real defects the suites caught.** (1) Intercompany account codes took the FIRST 4 hex chars
  of a uuid v7, whose leading digits are a millisecond timestamp - companies created in the same
  millisecond collided and `ON CONFLICT DO NOTHING` silently returned another counterparty's
  account. Now uses the random tail and refuses on collision. (2) Both finance seeds wrote
  `user_roles` outside the P2-04 choke point without being on the TRUSTED allowlist.
- **Consolidation is bounded by `root_company_id`** - `withTenants` refuses a tenant set spanning
  two roots, and reading both sides of an intercompany balance is a two-tenant read. Correct: two
  unrelated holdings must never consolidate.

### platform-ui `0.51.0` - network security console: traffic, threats, isolation, occupancy (2026-08-25) - PROTOTYPED

**Added**
- `src/lib/network.ts` - data layer + the BFF contract for `GET /api/:t/it/network/{traffic,threats,rules,presence}`
  and `POST .../isolate`, plus pure helpers (`topTalkers`, `egressByCountry`, `summarizeThreats`,
  `isFeedStale`, `describeExpiry`, `canProposeIsolation`). 25 tests in `network.test.ts`.
- `src/lib/demoNetwork.ts` - labelled fixture fallback, seeded from the 2026-08-25 office survey.
- `/it/network` (Traffic), `/it/network/threats`, `/it/network/rules` (Isolation),
  `/it/network/presence` (Occupancy), under a new `Network` tab in the IT console.
- `components/it/network.css`, `components/it/NetworkBanners.tsx`.
- Explicit `demoFixtures.ts` routes for the four endpoints.
- Design: `docs/superpowers/specs/2026-08-25-network-security-console-design.md`.

**Notes**
- ★ **The fourth plane.** `/it/topology` answers "what exists on the network" and
  `/systems/observability` answers "what are we running". Neither can answer "what moves, and can we
  stop it" - device inventory says nothing about who a device talks to. That needs flow + IDS data,
  a different source with different volume and a different retention policy.
- ★ **A fixture must never pass for live data.** Every response carries a `source` discriminator and
  every page renders a loud banner on `"fixture"`. This is the direct countermeasure to the 8
  invented devices at a nonexistent "Bali Office" that sat in the live tenant for months reading as
  a topology bug. **In production these pages render fixtures + banner until the Phase 3 backend
  exists** - deliberate, so the surface can be reviewed, but see the design doc if that trade should
  be reversed to an empty state.
- **No staff-identifying data in a committed fixture.** ~25 of the 40 client hosts have hostnames
  naming the employee holding the phone. Corporate asset names are real; every personal device is
  collapsed into an unnamed aggregate - which is also how the shipped product must treat them.
- **`demoFixtures.ts` routes are explicit, not incidental.** That file's final GET catch-all answers
  unmatched paths with `ok([])` - an empty ARRAY - and these readers expect an OBJECT, so falling
  through would hand the pages `rollups: undefined` and crash the render instead of degrading.
- **Occupancy is a facilities tool, worded as one.** Zones, occupancy, sensors - never "detection",
  never "intruder", never a name. `PresenceZone` has nowhere to put a person; the wording is the
  reminder, the shape is the guarantee.
- **Enforcement renders read-only.** Isolation will ride D14 (`approval-executables.ts`), be
  quarantine-scoped only, refuse four protected targets server-side including the approver's own
  host, and auto-expire. None of it is built, so the page states that rather than offering a button
  that would 404.
- `HairlineTable`'s grid has no column gap: a right-aligned header renders flush against the next
  left-aligned one and the two read as a single word. Found only by driving the page in a browser,
  after four green builds. Every right-aligned column now sits at the end of the table.

### finance `0.13.0` - F8 fixed assets: book AND tax depreciation (2026-08-25) - PROTOTYPED

**Added**
- `202608251030_finance_fixed_assets.sql` - `finance_asset_classes`, `finance_assets`,
  `finance_depreciation_runs`/`_lines`, `finance_tax_golongan_params()`,
  `finance_asset_depreciation_schedule()`.
- `src/db/finance-f8-fixed-assets.test.ts` - 14 tests.
- CoA template gains `1260` / `2250` (deferred tax balances), `6750` (impairment), `7400`
  (disposal result).

**Notes**
- ★ **Two schedules, deliberately.** Tax depreciation is statutory (golongan fixes life and
  permitted method); book depreciation is a PSAK 16 management estimate. They routinely disagree,
  and that difference IS the temporary difference feeding deferred tax - not an inconsistency to
  reconcile away. Keeping one number would move the other into a spreadsheet outside the ERP.
- **The final period absorbs rounding.** 10,000,000 over 3 months rounds to 3,333,333.33 x 3 =
  9,999,999.99. Charging the rounded figure every month strands a cent of book value on a fully
  depreciated asset forever, and it never reconciles against the GL.
- **Declining balance terminates.** Saldo menurun approaches zero asymptotically; the final period
  writes off the remainder. Without it an asset depreciates past its life by amounts small enough
  that nobody notices for years.
- **Buildings on saldo menurun are refused by CHECK**, not by the UI - the method is not permitted
  for them and a wrong tax return is not something anything downstream would catch.
- **Idempotency is a UNIQUE INDEX**, not a code path: one depreciation run per period, which is the
  only version that survives a retried job or two concurrent operators.
- The new CoA accounts are added to the TEMPLATE only. `finance_instantiate_coa()` reads
  tenant-scoped tables behind `app_module_allowed('finance')` and a migration has no such scope, so
  a back-instantiate loop there would write ZERO rows and report success. Re-run
  `seed:finance-config` (idempotent by code) to pick them up.

### finance `0.12.0` - live defaults: PKP, a finance seat, and the ownership edge (2026-08-25) - PROTOTYPED

**Added**
- `seed:finance-live-defaults` - PKP status, a finance seat, and the default ownership edge.
- `docs/PLACEHOLDER-PRINCIPALS.md` - the register of stand-in principals in the LIVE estate.

**Notes**
- ★ **Anthony gets ONE ownership row, not three.** The obvious reading of "Anthony 100%" is one
  row per company, and it is wrong in a way that quietly misstates the cap table. `kind='holding'`
  confers the company **plus every descendant** through `finance_owner_company_ids()`, and both
  operating companies are children of the holding - so a single edge already reaches all three.
  Three `shareholder` rows would resolve to the same set while asserting he holds the operating
  companies directly rather than through the holding vehicle, and `shareholder` deliberately
  carries no group reach. One edge says what is actually true.
- **`anthony@gaiada.com` is a real active account**, so ownership is NOT a placeholder.
- **The finance seat IS a stand-in** and is registered as P-01/P-02. A grant made without that
  register entry is a defect: a stand-in grant is invisible once made - `hansel@gaiada.com` already
  holds platform-wide access, so a finance grant on top produces no warning and looks identical to
  a correct assignment.
- ⚠ **SoD is not in force in the live estate.** The accountant and the finance manager are the same
  account. Acceptable while the books are empty; not once real transactions are posted - the ledger
  is append-only, so entries posted under a stand-in stay attributed to that person permanently and
  reassigning the role later does not re-attribute history.
- **Every value here is a DEFAULT and never overwrites one already set.** PKP is guarded on
  `is_pkp IS DISTINCT FROM true`, so a company an accountant deliberately marked non-PKP is not
  silently flipped back by a re-run.
- The seed refuses to CREATE users. Inventing a principal in a live estate is how a fictional
  employee ends up holding a finance grant.

### finance `0.11.0` - the seed can configure a LIVE estate (2026-08-25) - PROTOTYPED

**Added**
- `seed:finance-config` takes `--company=` (repeatable), `--year=` and **`--no-seats`**.

**Notes**
- ★ **`--no-seats` is the point.** The two `.local` seats exist so dev is not blocked on a hire.
  Seeding them into a live estate would put two fictional employees into production IAM holding
  real finance grants - in the one module where a principal has money attached. Config (chart,
  calendar, settings) is safe to seed anywhere; principals are not.
- Defaults are unchanged (`Gaia Digital Agency`, seats ON, current year) so the documented dev
  invocation and `finance-config.db.test.ts` behave exactly as before. Verified: 4/4 green.
- The live estate is seeded through this script rather than hand-rolled SQL deliberately. Every
  `finance_*` table composes `app_module_allowed('finance')`, so a statement run without the module
  scope set writes **zero rows and reports success**. The seed sets it; a psql session would not.

### platform-nest `0.38.1` - platform boots in seconds, not minutes (2026-08-25) - IN PROGRESS

**Fixed**
- `src/main.ts` - `runWorkActivityBackfill()` is no longer `await`ed ahead of `app.listen()`.
- `src/core/work-activity-backfill.ts` - the history scan skips already-ingested rows.
- `infra/compose/docker-compose.vps.yml` - platform healthcheck `start_period` 10s -> 300s.

**Why (the 2026-08-24 502)**
- platform took ~129s to reach "Server listening" on the live box. Its healthcheck allowed
  10s + 20x5s = 110s, so compose called it unhealthy **19 seconds before it was ready** and
  aborted `up -d` with "dependency failed to start". The abort is the damage: it leaves
  platform-ui, mcp-hub, knowledge, report-renderer and agent-runner in the **CREATED** state,
  never started. nginx and platform were both healthy; platform-ui simply was not running, so
  every public request 502'd. Both automatic rollbacks failed identically, for this reason.
- ~117s of that 129s was one statement: the work-activity backfill re-read the **entire**
  `activities` history for every company on every boot, then did three sequential round-trips per
  row (fallbackTitle, hintPayload, ingestWorkActivity) purely for ingest's `ON CONFLICT` to throw
  the result away.

**Notes**
- ★ **Two independent defects, fixed independently.** The healthcheck budget was too tight AND the
  boot was too slow; either alone would have caused this again. Raising the budget without fixing
  the boot just moves the cliff.
- The anti-join preserves semantics exactly. `work_activity`'s dedupe key is
  `(tenant_id, source, source_ref)` and `source_ref` IS the activity's id, so an existing row means
  already-ingested. The rerun contract was already "every row dedupes and reports 0" - it now
  reaches the same end state without doing the work. `source_ref` is TEXT and `activities.id` is
  UUID; the suite caught the missing cast (`operator does not exist: text = uuid`). The UUID side
  is cast, never `source_ref`, so the index stays usable.
- **Backfill -> consumer ordering is still load-bearing** and preserved. The consumer advances the
  stream position, so starting it first could carry it past the history the backfill replays. On
  failure the chain retries with capped backoff rather than starting the consumer - the old
  crash-and-restart intent, without taking the whole API down to retry a background job.
- Not fixed: `report-renderer` carries the same 10s `start_period`. It currently reaches healthy in
  ~20s so it is not biting, but it is the same latent shape.

### finance `0.10.0` - the /finance console + the config seed (2026-08-25) - PROTOTYPED

**Added**
- `platform-ui/src/lib/finance.ts` - the data layer, with TWO deliberate degradation strategies.
- `platform-ui/src/app/(app)/finance/page.tsx` - the overview console: position KPIs, the four
  integrity verdicts, the close gate, AR/AP aging and the fiscal calendar.
- `platform-ui/src/lib/demoFinance.ts` - DEMO_MODE fixtures (the build gate runs in demo mode).
- `platform-nest/src/seed/finance-config.ts` + `.db.test.ts` - `npm run seed:finance-config`.
- `docs/FRONTEND-BFF-CONTRACT.md` - the finance section.

**Notes**
- ★ **A verdict must never degrade to a pass.** Four figures on this page are checks that mean
  "problems found; empty = pass". The estate's usual `skipUnavailable(p, [])` would render a green
  tick for a check that never ran. So `lib/finance.ts` has `financeData` (may degrade) and
  `financeVerdict` (returns null), and the page renders "not checked" as visually distinct from a
  pass. This is the single most important line in the UI work.
- **The nav dedupes Finance.** An org structure frequently contains a department called Finance
  (nav.test.ts's own wide-estate fixture has one), so appending a functional row the way HR and IT
  are appended would render "Finance" twice, pointing at two different screens. The org row is
  re-pointed at the console instead; a functional row is added only when no department claims the
  name. Pinned by test.
- **`listPeriods` distinguishes 403 from 404**, because the page keys its empty state off it - and
  "you have no finance access" and "this company has no calendar" need opposite sentences. The
  first draft told a member with no access to go and run a seed script.
- **The demo fixture is deliberately not all-green**: one subledger does not tie and the current
  period is unsigned, so the "does not tie" badge, the problem table and the close blockers are
  reachable in a browser. A books-perfect demo cannot exercise the parts of this console that
  matter.
- **The seed does NOT sign off a period.** It seats a finance_manager and a finance_staff, enables
  the module, instantiates the chart and cuts the calendar - but stamping `signed_off_by` with a
  seeded persona would satisfy the D-F5 control while destroying the only thing it protects.
  Nothing else is blocked by it.

### finance `0.9.0` - FA Application Layer (2026-08-24) - PROTOTYPED

The surface a person can actually reach. Until this, the whole program was schema + SQL + policy.

**Added**
- `src/modules/finance/index.ts` - the module contract, registered in `main.ts` and `app.module.ts`.
  21 declared permissions; 6 MCP tools, all READ-ONLY.
- `src/modules/finance/finance.controller.ts` - 19 endpoints under `/api/:tenantId/finance/*`.
- `src/modules/finance/finance-error.filter.ts` - maps the `FINANCE_*` refusal family onto HTTP.
- `src/modules/finance/finance.test.ts` - 19 tests against live Postgres + RLS + Cerbos.
- `docs/modules/CAPABILITY-INVENTORY.md` regenerated (generated artifact).

**Notes**
- **The controller computes no accounting.** Every figure comes from a SQL function; it authorizes,
  scopes and shapes JSON. The invariants stay next to the data where a script cannot walk past them.
- **`withFinance()` is the only database path.** Every finance table is module-walled, so a plain
  `withTenants()` returns zero rows with a 200 and looks like it worked. The first API test exists
  to fail if that helper ever loses its module scope.
- ★ **The fifth body-less 500 in this estate.** An unbalanced journal returned
  `500 {"error":"internal error"}` - the database had computed `debits (100) <> credits (90)` and
  the transport discarded it, because plpgsql errors arrive as pg `DatabaseError` and
  `HttpErrorFilter` only catches `HttpException`. Fixed with a typed filter scoped to
  `@Catch(DatabaseError)` - NOT a bare `@Catch()`, which broke the controller's own 400s because
  re-throwing from inside a filter does not reach the next filter. Unrecognised `FINANCE_*` codes
  default to 409 with their own message, so future refusals map by construction.
- **MCP is read-only this wave.** An agent may inspect the trial balance, the aging and the close
  blockers. No tool posts a journal: under D14 that must be a proposal a human approves, and the
  finance approval surface does not exist yet.
- **Rollup providers deliberately empty** - a group-level finance metric would be a cross-company
  money figure, and a naive sum double-counts intercompany (blueprint 10.3a). Needs F9.

### lms `0.7.0` + lab-runner `0.2.1` — L6 and L7 (2026-08-25) — DEV-VERIFIED

**Added**
- L6a: companion-target support in the runner (`buildTargetArgs`), plus the deliberately
  vulnerable `lab-runner/targets/webapp-cmdi` image.
- L6b: a DevOps lab graded on real `nginx -t` output. L6c: a Cyber lab against the target.
- L7: `lms-creative-social-curriculum.ts`, `lms-seo-gm-curriculum.ts`, `lms-hr-it-curriculum.ts` —
  20 courses, 12 paths, 64 activities across six departments.

**Fixed**
- **gVisor does not proxy Docker's embedded DNS on `--internal` networks**, so an attacker could
  never resolve its target by alias. Resolved via `--add-host` with the target's real IP.
- **`buildLabRequest` dropped `target`** — the Cyber lab would have been gradeable in isolation
  and dead on arrival for a learner.
- **The Cyber flag was hardcoded in the seed and the test.** Caught before push. Now read from
  `LMS_CYBER_FLAG`, refused if unset, and asserted by shape rather than value — the first version
  of that assertion printed the flag on failure, which is the same leak by a slower route.
- **`spec-redaction.ts` now strips the WHOLE `gradingSpec`**, not just `answer`. A Cyber lab's
  pass condition is "did you get the flag", so the flag lives in a `stdoutMatches` pattern.

**Notes**
- The target is as hardened as the attacker and never publishes a port.
- No DevOps/Cyber lab existed before the runner could grade them: a required activity nothing can
  pass makes its whole path permanently uncompletable.
- Suites were re-run SERIALLY. Four agents against one test Postgres produced a `57P01` failure
  that was contention, not a defect — a green or red number gathered under that load is not
  evidence either way.

Driven: 95/95 across 9 suites. Runner 31/31.

### lms `0.5.0` + lab-runner `0.1.1` — L5 complete: labs run on a real host (2026-08-25) — DEV-VERIFIED

**Added**
- `202608250950_lms_l5_lab_runs.sql` — the dispatch record and its rate-limit index; plus the
  `ux_lms_attempts_id_tenant` that every other lms_* table already had.
- `src/modules/lms/lab-dispatch.ts` + the lab branch of `submitAttempt`.
- `src/seed/lms-webdev-labs.ts` + `seed:lms-webdev-labs` — FE, BE and QA labs.
- Tests: `lab-dispatch.test.ts` (7), `lms-webdev-labs.db.test.ts` (9).

**Verified on the deployed runner, both directions**
- Every REFERENCE solution scores 100 under gVisor on SumoPod.
- Every untouched STARTER scores 0 (QA: 14.29). A lab whose starter passes teaches nothing.

**Notes**
- The graded test file is a challenge FIXTURE, never a starter. A learner file cannot displace a
  fixture — overwriting test.js with `process.exit(0)` is the obvious full-marks exploit.
- The QA lab inverts the usual exercise: the implementation is given and broken, and the learner
  is graded on whether their tests FAIL against it and PASS against a correct one — the only
  definition of a useful test.
- No DevOps or Cyber lab is authored. Both need runner capability that does not exist until L6.
### lab-runner `0.1.0` — L5a The lab execution sidecar (2026-08-25) — PROTOTYPED

A new standalone service. Executes a learner's submission in a capped, unprivileged,
network-less container and returns a graded result. `lab-runner/README.md` is its own guide.

**Added**
- `lab-runner/` — `config.ts` (every default chosen against SumoPod as measured), `sandbox.ts`
  (the docker argument list — the security boundary), `queue.ts` (hard concurrency cap, bounded
  backlog, refusal rather than an unbounded wait), `grade.ts` (four check kinds, server-side),
  `runner.ts`, `server.ts` (three routes, no framework).
- 25 unit tests: `sandbox.test.ts` pins every isolation flag; `grade.test.ts` pins the grader.

**Fixed during the end-to-end drive — neither was visible to the unit tests**
- A plain `--tmpfs /work` is created ROOT-OWNED, so `--user 65534` could not write a byte to it.
  Every run failed with `cp: can't create '/work/...': Permission denied`.
- A docker VOLUME chowned by a prep container looked like the fix and is not portable: Docker
  Desktop masks volume ownership per container, so the chown appears to take and the next
  container still sees `root`. `chmod 0777` behaves the same way. Verified directly.
  Fix: `--tmpfs /work:rw,nosuid,size=128m,mode=1777,uid=65534,gid=65534`.

**Notes**
- **NO KVM on the target host.** Containers are the only boundary, on a box sharing a kernel with
  19 containers of the owner's private production.
- **`image` is a KEY into an allow-list**, never a reference. Honouring a caller-supplied image
  there would turn the endpoint into "run anything as that image's entrypoint".
- **`fileExists` is forgeable and says so.** The artefact listing comes from inside the learner's
  own container; pair it with a `stdoutMatches` on the real tool's output for anything that
  matters. No artefact report can be non-forgeable while the learner controls the producer.
- Limits are CLAMPED, never honoured. A spec with no checks scores zero, never 100.

**Not yet true:** not deployed. No platform-side dispatch (L5b), no labs (L5c), and nothing on
SumoPod has been touched.

### lms `0.4.0` — L4 The Web Dev curriculum (2026-08-25) — PROTOTYPED

Six disciplines, ordered, foundation through lead. Structure and theory; the hands-on labs are L5.

**Added**
- `src/seed/lms-webdev-curriculum.ts` + `seed:lms-webdev-curriculum` — 8 paths, 14 courses,
  42 activities, 14 graded quizzes. FE · BE · UI/UX · DevOps · Cyber Security · QA, plus a shared
  foundation path and a lead path.
- `src/seed/lms-webdev-curriculum.db.test.ts` — 7 tests.

**Notes**
- **No `lab` is authored, deliberately.** The runner arrives at L5; a required activity nothing
  can grade makes its whole path permanently uncompletable. The seed refuses to finish if it finds
  one and the test asserts zero.
- **`requires_previous` throughout** — "steps so difficulties are in order", enforced in data.
- **Mixed grading by discipline**: UI/UX and the lead track use reviewed `scenario` activities
  with a rubric; the objective disciplines auto-grade.
- Answers are option INDEXES, not text: an author fixing a typo in an option must not silently
  invalidate every correct answer already recorded against it.

**Not yet true:** nobody is enrolled — these are department paths the head assigns, not mandatory
ones. No labs, no runner.

### lms `0.3.0` — L3 The HOD authoring surface (2026-08-25) — PROTOTYPED

"Later each HOD should make more" — the surface that makes it true. NO new backend: L1b already
had every endpoint, so this is the write layer and the pages.

**Added**
- `platform-ui/src/lib/lmsActions.ts` — createCourse / updateCourse / publish / retire, modules,
  activities, paths. The `ctx()` + `send()` shape every other actions file uses.
- `/learning/authoring` and `/learning/authoring/[courseId]`; `components/lms/CourseForm.tsx`,
  `AuthoringForms.tsx`, `LmsActionButton.tsx`; an Authoring nav row gated on `lms.authoring`.
- `getCourse(..., { includeAnswers: true })` — the authoring read, re-authorized for `update`.
- `e2e/lms-authoring.spec.ts` — 5 assertions driven against the rendered app, including the
  negative control (a plain member is refused and pointed at the catalogue).
- `lib/demoLms.ts` is now STATEFUL for authoring and implements fork-on-publish.

**Notes**
- **The authoring bound is not in this layer.** `resource_lms_course.yaml`'s `org_unit_lead` arm
  matches on server-resolved `unitAncestors`; the department select is a convenience. `can(me,
  "lms.authoring")` answers "may ask", never "may touch this course".
- **Every mutating action surfaces `versioned`.** Editing a published course forks a new draft,
  and an author who does not see that sentence believes they fixed live training and did not.
- **Publish and retire are `lms.publish`, not `lms.authoring`.** Publishing freezes what people
  will be certified against; retiring withdraws material somebody may be part-way through.
- **e2e locators are name-based, not `getByLabel`.** getByLabel substring-matches the accessible
  name, and "Title" collided with the course-key hint ("...it survives title changes..."). A
  locator that breaks when someone edits help text is a locator that will break.

**Not yet true:** attempt submission has no demo fixture and the lab runner does not exist (L5).
Path authoring has server actions but no page yet — paths are listed, not built, in the UI.

### lms `0.2.0` — L2 The general track and the training tenant (2026-08-25) — PROTOTYPED

The wave with the widest reach and no execution risk: content every employee takes, and the
isolated place ERP exercises are practised in.

**Added**
- `202608241550_lms_l2_general_track_and_training_tenant.sql` — `companies.is_training` with a
  partial unique index (at most ONE, ever), `lms_cohorts` / `lms_cohort_members`,
  `lms_training_reset_tables` (the allow-list, as DATA) and the append-only `lms_training_resets`.
- `src/seed/lms-general-track.ts` + `seed:lms-general-track` — three published courses and one
  mandatory path. Sixteen assessed questions.
- `src/modules/lms/mandatory-assignment.ts` + `lms:assign-mandatory` — the enrolment sweep,
  dry-run by default.
- `src/modules/lms/training-tenant-reset.ts` + `lms:reset-training` — the bounded reset. Dry-run
  by default; `--execute` additionally requires `--i-have-read-the-plan`.
- `src/modules/lms/spec-redaction.ts`, `spec-redaction.test.ts` (7), `lms-l2.db.test.ts` (16),
  and 4 new HTTP assertions in `lms-l1-acceptance.test.ts` (21 total).

**Fixed — both silent, neither would have thrown**
- **The quiz answer key was readable by every learner.** `GET /courses/:id` returned
  `lms_activities.spec` verbatim and `resource_lms_course.yaml` names `member` in its read rule
  deliberately. High scores on a mandatory track look exactly like training that works. Redacted
  by default now, stripped by FIELD NAME at any depth rather than by knowing each kind's shape —
  the kinds L5/L6 add are precisely what a shape-aware stripper would miss. `?includeAnswers=1`
  re-authorizes for `update`; a learner asking is refused rather than quietly redacted.
- **The training-tenant reset left the membership door open.** `revokeCohortAccess` deleted
  `company_memberships` under `withGlobal`, but that table carries FORCE RLS — zero rows, success
  reported. `user_roles` has no RLS, so the other half of the same function worked. Caught by an
  assertion that the REAL company's membership survived, not by anything failing.

**Notes**
- **Reset, not delete, and the bound is in the database.** 186 tables carry `tenant_id` and there
  is no hard-delete path for a company. The runner reads an allow-list table and NEVER derives one
  from `information_schema`; the tenant is resolved from `is_training` and cannot be passed in.
- **Per-table row counts, never a total.** A total hides the table that matched zero rows when it
  should have matched hundreds — which is how the RLS zero-row trap presents.
- **An unrecognised `applies_to` matches NOBODY.** 'unit' and 'discipline' arrive with L4; reading
  an unknown scope as "all" would enrol the whole company in one department's path.
- An employee with no `users` row is NAMED in the sweep output, never counted — a hole in
  coverage reported as a number is one nobody closes.

**Not yet true:** no company carries `is_training`, so the reset refuses outright; nothing is
deployed and `lms` is enabled on no live company.
### lms `0.1.0` — L1 Learning foundation (2026-08-24) — PROTOTYPED

The LMS the owner asked for: **all departments, all levels**, operational and management alike.
Its **own module key**, not filed under `hr` — filing a company-wide capability under one
department would have made Creative's or SEO's training silently depend on `hr` being served to
them. Design: `docs/blueprints/lms-foundation.md`.

**Added**
- `202608241322_module_lms_l1.sql` — 9 tables behind the `lms` third wall: `lms_courses`
  (versioned by `(course_key, version)`), `lms_modules`, `lms_activities` (polymorphic
  `read|watch|quiz|scenario|lab`), `lms_paths`, `lms_path_courses`, `lms_enrollments`,
  `lms_progress`, `lms_attempts`, `lms_completions`.
- `cerbos/policies/resource_lms_course.yaml` + `resource_lms_enrollment.yaml`;
  `202608241340_iam_lms_l1_permissions.sql` — `lms_staff`/`lms_manager` roles, 12 permissions,
  68 bundle rows. See `docs/PERMISSION-CONTRACT.md`.
- `src/modules/lms/` — catalogue + learn controllers, 5 rollup metrics, 3 read-only MCP tools,
  `lms-l1-acceptance.test.ts` (20 assertions over `buildApp()` + `app.inject()`).
- **platform-ui (L1c):** `/learning`, `/learning/catalogue`, `/learning/courses/[id]`,
  `/learning/compliance`, a `/me/learning` tab, `lib/lms.ts`, 7 mirrored capabilities in
  `lib/rbac.ts`, a `learning` mortarboard icon, `lib/demoLms.ts` fixtures,
  `src/lib/lms-readers.test.ts` and `e2e/lms-learning.spec.ts` (6/6 driven against the rendered
  app under DEMO_MODE).

**Fixed**
- **`lib/lms.ts` called `platformFetch(userId, path)` — arguments swapped — in every reader.**
  Both parameters are `string`, so `tsc` and 3,110 vitest assertions all passed while the LMS
  paths were never requested: the demo catch-all answered `[]` and the catalogue rendered
  "nothing published yet". A confident wrong answer with nothing thrown — the frontend-first
  drift class this repo keeps getting bitten by. Caught only by driving the rendered page;
  `lms-readers.test.ts` now runs each reader against the fixture store and asserts CONTENT, so
  a wrong path fails instead of degrading.
- `gradeAttempt` never passed `unitAncestors` to Cerbos, so every department head 403'd on
  grading — the derived role could not resolve.

**Notes**
- **Editing a PUBLISHED course forks a new version** rather than rewriting it. A completion points
  at the exact material that was assessed — the same freeze discipline as a payslip.
- **A waiver is not a completion**, and a path with zero required courses reports NULL, not 100%.
- **One dual-scope call in the whole module** (`{ modules: ["lms", "hr"] }`), for the certification
  write onto the employee's HR file. Every other query declares `["lms"]` alone.
- `lab` activities share the row shape but have no runner yet (L5/L6, the owner's SumoPod VPS).
  Theory does not wait on the sandbox.

**Not yet true:** nothing LMS is deployed, and the `lms` module is **not enabled on any live
company**. No content exists — the mandatory general track is L2, HOD authoring L3, the Web Dev
curriculum L4.

### finance `0.8.0` - F2 Posting Rules (2026-08-24) - PROTOTYPED

The seam other departments post through. **Business modules emit events in their own vocabulary;
finance owns the mapping to accounts.**

**Added**
- `202608241027_finance_posting_rules.sql` - `finance_posting_rules` + rule lines,
  `finance_ledger_events` (the inbox), `finance_process_event()`,
  `finance_process_pending_events()`, `finance_event_backlog()`.
- `202608241028_iam_finance_f2_posting_rule_permissions.sql` +
  `resource_finance_posting_rule.yaml` - 4 keys. See `docs/PERMISSION-CONTRACT.md` section 24.
- `src/db/finance-f2-posting-rules.test.ts` - 16 tests.

**Notes**
- **There is no expression language, and that is the most important decision here.** A rule line
  takes an amount from a NAMED PATH in the payload times an optional fixed multiplier. Nothing else.
  The moment a rule can compute, the chart of accounts becomes a programming language with no
  debugger, no tests and no review - and "why did this post there?" stops having a short answer. If
  a mapping needs logic, the emitting module computes the number and puts it in the payload, where
  it is ordinary code with ordinary tests.
- **Adds no second way into the ledger.** `finance_process_event()` builds a line array and hands it
  to `finance_post_journal()`, so balance validation, period guards, account guards, the hash chain
  and idempotency all apply unchanged. Pinned by tests: an unbalanced rule and a locked period both
  fail through F1's own errors.
- **Accounts are named BY CODE, resolved at post time.** A stored account id would keep posting
  silently after an accountant re-codes an account; a code breaks loudly, which is the correct
  failure. Pinned by test.
- **A failed event stays VISIBLE with its reason.** Unposted revenue is the thing nobody notices -
  the books simply look smaller and everything still reconciles. Each event is swept in its own
  subtransaction so one bad event cannot roll back the batch AND so its failure record survives.
- `RULE_NOT_EFFECTIVE` is distinguished from `NO_ACTIVE_RULE`. The first draft reported both as "no
  active rule", which the test suite hit immediately: a rule created today cannot post an event
  dated in February, and the message named a rule that was sitting there plainly active.

### finance `0.7.0` - F7 Tax and Statutory (2026-08-24) - PROTOTYPED

F4 and F5 already recorded the tax. F7 turns it into returns.

**Added**
- `202608241025_finance_tax_and_returns.sql` - `finance_tax_codes` (rate + base multiplier,
  effective-dated), `finance_tax_returns` (filing record with as-filed snapshots),
  `finance_coretax_extracts`; `finance_tax_compute()`, `finance_tax_ppn_summary()`,
  `finance_tax_pph_summary()`, `finance_tax_efaktur_exceptions()`,
  `finance_tax_coretax_reconcile()`.
- `202608241026_iam_finance_f7_tax_permissions.sql` + `resource_finance_tax.yaml` - 4 keys.
  See `docs/PERMISSION-CONTRACT.md` section 23.
- `src/db/finance-f7-tax.test.ts` - 14 tests.

**Notes**
- **Input VAT with no e-Faktur is NOT creditable** - the rule with a direct money consequence. It is
  EXCLUDED from the claim and reported separately rather than silently netted: the company pays it
  and cannot reclaim it, so the amount lost has to be visible while somebody can still chase the
  vendor for the faktur.
- **A single `rate` column cannot express Indonesian PPN.** Since 2025-01-01 the statutory rate is
  12% applied to ELEVEN TWELFTHS of the base - an effective 11%. Storing "11%" loses what the tax
  office cares about; storing "12%" alone overstates by ~9%. Codes carry `rate` AND
  `base_multiplier`, and are effective-dated so a 2024 supply keeps its full-base 11%.
- **`finance_tax_efaktur_exceptions()` reports two kinds, deliberately not merged.**
  `AR_MISSING_EFAKTUR` is a compliance failure (the customer cannot credit it either);
  `AP_INPUT_VAT_LOST` is a money loss. Same symptom, opposite consequence, different person to
  chase.
- **A return snapshots its figures AS FILED.** A late invoice booked after filing moves the live
  figure; the filed figure must not move, because an auditor asks about exactly that gap. Pinned by
  test.
- **Transmission to Coretax is NOT built and must not be** (blueprint section 6, D-F2 carve-out) -
  that goes through a licensed ASP/PJAP. What F7 owns is the harder half: correct tax data, and the
  monthly reconciliation between our ledger and DJP's pre-populated extract.

### finance `0.6.0` - F6 Bank Reconciliation and the Close (2026-08-24) - PROTOTYPED

**Added**
- `202608241023_finance_bank_and_close.sql` - bank statements, transaction lines, statement/ledger
  matches; `finance_bank_automatch()`, `finance_bank_reconcile()`, and
  **`finance_period_close_readiness()`** - the capstone that aggregates F1 ledger integrity, F3
  statement balance, F4/F5 subledger tie-outs, F6 bank reconciliation and the D-F5 sign-off into one
  answer.
- `202608241024_iam_finance_f6_bank_permissions.sql` + `resource_finance_bank.yaml` - 4 keys.
  See `docs/PERMISSION-CONTRACT.md` section 22.
- `src/db/finance-f6-bank-close.test.ts` - 13 tests.

**Notes**
- **The auto-matcher is deliberately conservative.** It matches only on an exact amount + direction
  + near-date triple, and REFUSES to match where two ledger lines are equally plausible. An
  aggressive matcher clears the queue and produces a reconciliation that looks complete while
  pairing the wrong payment with the wrong invoice - surfacing months later as a customer chasing
  money we recorded against someone else. An unmatched item costs a minute; a wrong match costs a
  relationship and an audit finding.
- **There is no plug.** `finance_bank_reconcile()` reports a position - GL balance, statement
  balance, each class of item in flight, and the unexplained residue. No adjustment field exists,
  because a difference nobody can explain is the finding.
- **The statement is never edited to match the ledger.** No function updates a transaction row. The
  test proves the right way to clear an unrecorded bank charge is to POST it.
- `finance_period_close_readiness()` does NOT close anything. It says whether you should; F0's state
  machine still governs who may, and still refuses OPEN -> HARD_LOCK and an unsigned hard lock.
- **Bank feed / API import is not included.** Lines arrive as data; the source (CSV, OFX, API) is an
  integration concern with its own credentials and changes none of the reconciliation logic.

### finance `0.5.0` - F5 Accounts Payable (2026-08-24) - PROTOTYPED

The mirror of F4, plus Indonesian withholding tax.

**Added**
- `202608241021_finance_ap_subledger.sql` - vendors, bills + lines (input VAT per line, withholding
  at bill level), payments, allocations; `finance_ap_approve_bill()`, `finance_ap_record_payment()`,
  `finance_ap_allocate()`, `finance_ap_aging()`, `finance_ap_position()`, `finance_ap_reconcile()`.
- `202608241022_iam_finance_f5_ap_permissions.sql` + `resource_finance_ap.yaml` - 6 keys.
  See `docs/PERMISSION-CONTRACT.md` section 21.
- `src/db/finance-f5-ap.test.ts` - 14 tests.

**Notes**
- **Withholding is the thing AP has that AR does not.** On a 100m services bill with PPh 23 at 2%:
  the expense is 100m, the VENDOR is owed 98m, and DJP is owed 2m. Two real liabilities, different
  creditors, different due dates. Booked at BILL APPROVAL, not at payment - the liability to DJP
  arises when the expense is recognised, and it keeps `amount_payable` equal to what the vendor is
  actually owed, which is what the aging must show. An aging listing gross bills overstates the cash
  that will leave.
- Allocation is capped at `amount_payable`, never `total`: the withheld tax was never the vendor's
  to be paid, and allocating against the gross would let a payment "overpay" by the withholding.
- **The reconciliation identity was reused from F4, second term and all** - open bills minus
  payments on account = control balance. F4's suite had to discover that; this one pinned it from
  the start, and the AP tests exercise a genuine vendor prepayment to prove it.
- `npwp` on a vendor is load-bearing, not decorative: its absence changes the withholding rate under
  Indonesian rules.
- **3-way matching (PO / goods receipt / bill) is NOT included.** It needs a purchase order and a
  goods-receipt document and there is no procurement module - a "match" against documents that do
  not exist would be theatre. Recorded as a dependency.

### finance `0.4.0` — F4 Accounts Receivable (2026-08-24) · PROTOTYPED

The first subledger. Schema + functions only.

**Added**
- `202608241019_finance_ar_subledger.sql` — customers, invoices + lines (tax as data per line),
  receipts, allocations; `finance_ar_issue_invoice()` (DR AR control / CR revenue / CR PPN
  Keluaran), `finance_ar_record_receipt()`, `finance_ar_allocate()`, `finance_ar_aging()`,
  `finance_ar_position()`, and `finance_ar_reconcile()` — the subledger-to-GL tie-out.
- `202608241020_iam_finance_f4_ar_permissions.sql` + `resource_finance_ar.yaml` — 6 keys, actions
  mapped onto SoD duties. See `docs/PERMISSION-CONTRACT.md` §20.
- `src/db/finance-f4-ar.test.ts` — 16 tests, reconciliation asserted empty after every state change.

**Changed**
- `202608241015` — `finance_post_journal()` gains `p_subledger`. Control accounts stay barred to
  manual journals, but the subledger that OWNS one may post to it. Deliberately narrow: it unlocks
  only control accounts whose `control_subledger` matches, so an AR posting is still refused on the
  AP control account.

**Notes**
- ⚠ **The reconciliation identity is NOT "open invoices == control account".** The test suite caught
  that on its first run. A receipt credits AR the moment the money lands, before allocation, so a
  customer who prepays leaves a credit inside the control account. The identity is
  **open invoices − payments on account = control balance**, exposed by `finance_ar_position()` so
  no caller re-derives it differently. The naive version reports a mismatch on every prepayment,
  which teaches people to ignore the reconciliation — the exact failure it exists to prevent.
- **Aging buckets by DAYS OVERDUE, not invoice age.** An invoice on 60-day terms issued 45 days ago
  is current; ageing by issue date makes a healthy book look distressed.
- **Allocation posts no journal.** The money moved when the receipt was recorded; allocation only
  says which debt it settles. Asserted by counting journal entries before and after.
- **Credit limits, dunning and credit memos are NOT included** — policy layers on top of a working
  subledger. `credit_limit` is stored but deliberately unread; a silently unchecked limit is worse
  than an absent one.

### finance `0.3.0` — F3 Statements (2026-08-24) · PROTOTYPED

**The phase project-hug never reached.** Its `FINANCE_PHASE_ROADMAP.md` §8 is entirely unchecked,
including its own "Total Assets must equal Liabilities + Equity" checkpoint — so this was walked
from first principles and verified by test.

**Added**
- `202608241017_finance_statements.sql` — `finance_account_movement()` (the shared engine, so no two
  statements can disagree about what a balance is), `finance_trial_balance()`,
  `finance_general_ledger()` with a continuous running balance and correct opening balance,
  `finance_profit_and_loss()`, `finance_net_profit()`, `finance_balance_sheet()`, and
  `finance_verify_statements()` (one row per problem; empty = pass).
- `202608241018_iam_finance_f3_statement_permissions.sql` + `resource_finance_statement.yaml` — the
  `finance_statement` kind, `read` + `export`. See `docs/PERMISSION-CONTRACT.md` §19.
- `src/db/finance-f3-statements.test.ts` — 13 tests, including A = L + E surviving a reversal.

**Notes**
- **A = L + E only holds because current-period profit is carried into equity.** Revenue and expense
  are temporary accounts that close into retained earnings at year end; before that close their net
  is still equity, just unmoved. Omit it and the sheet is out by exactly the year-to-date profit.
  `p_fy_start` is therefore a required argument, not a defaulted one — "profit so far" is meaningless
  without knowing when the year began, and not every company's year starts in January.
- **Contra accounts derive their sign from `normal_balance`, never from a hardcoded code list.**
  Both directions are pinned: a sales return (revenue/debit-normal) nets negative against revenue,
  and accumulated amortisation (asset/credit-normal) presents negative under assets.
- **Reversed entries are NOT excluded from statements.** A reversed entry and its reversal both
  appear and net to zero — the auditable answer. Filtering them would disagree with the trial
  balance and hide a correction.
- **Implemented as functions over the ledger, not materialised projections.** A projection can drift
  from the ledger (a whole failure class project-hug needed an integrity service to manage); an
  aggregation cannot, because it IS the ledger. The signatures are what must stay stable — the
  projection can land behind them when measurement calls for it, and these tests become the oracle
  proving it agrees.
- **Cash Flow is deliberately NOT included.** The indirect method needs each account classified as
  operating/investing/financing — CoA metadata that does not exist yet. Inventing it inside a query
  would hide a modelling decision; it gets its own ticket.

### finance `0.2.0` — F1 Ledger Core (2026-08-24) · PROTOTYPED

The book of record. Schema + functions only — still no HTTP surface, no statements (F3), no
subledgers (F4/F5).

**Added**
- `202608241015_finance_ledger_core.sql` — `finance_journal_entries` / `_lines` /
  `_line_dimensions`, immutable by trigger; `finance_post_journal()` (the one way in — idempotent on
  `source_event_id`, totals computed FROM the lines, per-company advisory lock so the sequence and
  hash chain cannot fork); `finance_reverse_journal()` (correction is a mirrored entry, never an
  edit); `finance_verify_ledger_chain()` (returns one row per PROBLEM — an empty result is the pass
  condition); SHA-256 chain with one canonical serialisation shared by writer and verifier.
- `202608241016_iam_finance_f1_ledger_permissions.sql` + `resource_finance_ledger.yaml` — 4 keys on
  the new `finance_ledger` kind, role-arm only. See `docs/PERMISSION-CONTRACT.md` §18.
- `src/db/finance-f1-ledger.test.ts` — 25 tests through the NOBYPASSRLS app role.

**Changed**
- `202608241011` CoA seed: **bank, cash and tax accounts are no longer flagged as control
  accounts.** Control means "reconciled against a subledger that POSTS INTO IT" (AR, AP, inventory,
  fixed assets), not "reconciled" in general — bank and cash reconcile against a *statement*.
  Driving the first real posting rejected a rent payment from `1120 Bank`, which was the correct
  behaviour for the flag and the wrong flag for the account. 16 control accounts → 5.

**Notes**
- The reversal link points FORWARD ONLY (`reversal_of_id` on the reversing entry). A `reversed_by_id`
  on the original would require updating a posted journal — the exact thing the table forbids — so
  status is derived via `finance_journal_entry_status()`. `finance_reverse_journal()` performs zero
  updates on the ledger.
- The immutability trigger's entries-only column check had to be NESTED, not a flat AND-chain:
  plpgsql resolves `OLD` against the triggering table, so `OLD.entry_hash` raised
  `record "old" has no field "entry_hash"` when firing on lines. Still fail-closed, but surfacing as
  an internal error instead of the ledger's own message. Pinned by a regression test.

### finance `0.1.0` — F0 Foundations (2026-08-24) · PROTOTYPED

First code for the Finance & Accounting department. **Schema and authz only — nothing posts yet.**
Design: `docs/blueprints/finance-accounting-foundation.md`. Tracker:
`docs/plans/2026-08-24-finance-PROGRESS.md`.

**Added**
- `202608241010_finance_ownership_and_scope.sql` — `company_ownership` graph + the scope resolver
  (`finance_owner_company_ids`, cycle-guarded `finance_company_descendants`) implementing owner
  ruling D-F8: a holding owner reaches every descendant, a company shareholder reaches only their
  own company. Establishes the `finance` third wall.
- `202608241011_finance_coa_and_dimensions.sql` — chart of accounts as **editable data** (ruling
  D-F5) with a 69-line PSAK-aligned Indonesian template incl. PPN Masukan/Keluaran and PPh
  21/23/4(2); accounting dimensions with per-account `required/optional/forbidden` rules; a freeze
  trigger making an account's code/type/normal-balance immutable once posted.
- `202608241012_finance_fiscal_calendar_and_currency.sql` — fiscal calendar with the
  `OPEN → SOFT_LOCK → HARD_LOCK` state machine (HARD_LOCK terminal; refuses without a named
  accountant sign-off), currencies, exchange rates carrying their `basis` (spot/closing/average),
  and `finance_period_accepts_posting()`.
- `202608241013_finance_sod_and_elevation.sql` — 12 finance duties and the 6 blocking
  segregation-of-duties pairs; elevation grants that cannot be approved without an expiry and lapse
  on their own; append-only finance access log.
- `202608241014_iam_finance_f0_permissions.sql` — 13 grantable permissions across 3 new Cerbos kinds
  (`finance_config` / `finance_period` / `finance_control`), the `finance_staff` / `finance_manager`
  roles, and 48 generated bundle rows. Role-arm only, no `perm_*` mirror. See
  `docs/PERMISSION-CONTRACT.md` §17.
- `cerbos/policies/resource_finance_{config,period,control}.yaml`.
- `src/db/finance-f0-foundations.test.ts` — 35 tests through the NOBYPASSRLS app role.

**Notes**
- The scope resolvers are `SECURITY DEFINER` **by necessity**: they read tenant-walled tables in
  order to COMPUTE the tenant set, so as INVOKER they returned the empty set for everyone —
  including the holding owner — silently. Caught by the test suite on its first run.
- Four new authoring groups in `permission-groups.json`; pinned tallies updated in
  `cerbos-catalog-alignment`, `permission-groups-catalog-parity`, `iam-215-boundary-pin` and
  `ui-grantable-catalog` (320/81 → 333/84 pairs/kinds, 305 → 318 grantable).
- **No handlers, endpoints or UI.** F1 (ledger core) is the next phase; the IAM arm is deliberately
  role-arm only until those handlers exist and their holders are audited.

### hr `0.4.0` + platform-nest `0.38.0` + platform-ui `0.49.0` — 2026-08-24 — HR-FULL: the department, waves A–D

**Status: MIXED, and the mix is the point.** Schema/RLS and the pure engines are **DEV-VERIFIED**;
handlers and UI are **PROTOTYPED**. See the per-layer table in
[`MODULES.md`](./MODULES.md#hr--people--hiring--pay--040--in-progress) — nothing here was driven
end-to-end against a running stack, and "the unit suite is green" is not that.

Owner ask (2026-08-24): finish the HR department — research the best HR ERPs, find what was not yet
planned, and build it. Scope confirmed as all four waves **including payroll**, and PII posture
confirmed as label-only per 0109's precedent.

**What the audit found.** `docs/blueprints/hr-department-foundation.md` §3 listed seven candidate
capabilities. Measured against the standard HCM capability map, **five more gaps existed that the
blueprint did not name at all** — and they were the load-bearing ones:

- `hr_leave_balances.allocated_minutes` had **nothing that computed it**. It was a number somebody
  typed, and nothing in the system could restate how it was reached.
- **There was no holiday calendar.** A five-calendar-day leave request spanning a weekend was charged
  as five days.
- `employees` held CURRENT state only, so every promotion, transfer and status change **OVERWROTE the
  previous fact**. Tenure, turnover and any statutory severance calculation were unanswerable from
  the database.
- `hr_records` had no validity. **An expired work permit and a current one were byte-identical to
  every query in the system.**
- Nothing modelled what anyone is paid.

#### Added

- **33 tables across four migrations** (`202608240140`–`0143`), every one behind the byte-identical
  0028 third-wall predicate, applied through the same DO-loop shape so it cannot drift per table.
  - **A** — holiday calendars (with Indonesian *cuti bersama*, which is not worked but IS charged —
    two facts that needed two counters), leave policies + assignments + an append-only accrual ledger,
    `hr_job_events` (the effective-dated worker history), document expiry + a reminder ledger, review
    cycles + participants, and an append-only case timeline.
  - **B** — the ATS. `hr_candidates` is a population **deliberately separate from `employees`**:
    different legal basis, its own retention clock, and nothing that provisions access may reach it.
    Hiring is an explicit CONVERSION, and `ck_hr_offer_conversion` makes "converted ⟺ has an
    employee_id" a database invariant rather than a convention.
  - **C** — pay grades, effective-dated compensation, allowances, BPJS enrolment, PPh 21 tax profiles.
  - **D** — statutory parameter sets, payroll runs, frozen payslips + itemized lines, per-period
    inputs, separations.
- **Four pure engines**, no database and no clock: `working-days.ts`, `leave-accrual.ts`,
  `payroll-calc.ts` (PPh 21 TER + progressive reconciliation + BPJS + THR), `severance.ts`
  (PP 35/2021's three components). **109 unit tests.**
- **Three Cerbos kinds** — `hr_policy` (read deliberately WIDE), `hr_recruitment` (wider than
  `hr_case` on read, narrower on write, with an attribute-gated panel arm), `hr_payroll` (a step
  ABOVE `hr_record`) — plus 18 catalog permissions, 11 authoring groups, role bundles, and migration
  `202608240144`.
- **Four controllers**, eight read-only MCP tools, five new rollup metrics, seven console pages and
  `/me/pay`.

#### Fixed / corrected

- **`app_module_allowed()` returns NULL, not `false`, on an unset GUC.** 0028's header says "false".
  Verified against a live Postgres. The wall is unaffected (RLS admits only TRUE), but anything
  OUTSIDE a policy is affected — `IF NOT app_module_allowed(...)` never fires on NULL. Corrected in
  `202608240140`'s header and pinned by the test as NOT-TRUE rather than as false.
- **Four Cerbos resource attributes were silently dropped.** `resourcePayload()` in `cerbos.ts` is an
  explicit allow-list, and `published` / `panelistUserIds` / `hiringManagerUserId` /
  `recruiterUserId` were not in it. Two of them arrive through an object spread, where TypeScript's
  excess-property check does not fire — so the type alone would not have caught it, and every
  panelist would have been denied for no visible reason.
- **Seeding `member` was tried as an exclusion and reverted.** Omitting `member`'s self/panel-scoped
  bundle rows broke `role-permission-parity.db.test.ts`, correctly: Cerbos genuinely grants them. The
  safety argument is the ABSENT `perm_*` mirror, not an absent row — which is exactly what 0094
  already established for `hr_case`.

#### Caught by the FULL suite, after the touched-file suites were already green

Recorded because it is the argument for the whole gate. Three failures, none in an HR suite:

- **Cerbos had not reloaded** the three new policy files, so the live PDP denied all 18 new keys
  (`authz-permissions.controller.test.ts`). Restarted, then **probed with real decisions** rather
  than trusting health: own PUBLISHED payslip ALLOW / own DRAFT DENY / another's DENY; panelist
  read+create ALLOW but update+delete DENY; non-panelist all DENY; hiring manager read+update ALLOW
  but approve DENY; member on `hr_policy` read ALLOW but update+ratify DENY.
- **A real routing regression** (`override-request-decide.test.ts`). `routeFor()` counts a role's
  sensitive, non-self-scoped HR permissions to pick an override approver; `member`'s three
  panel-gated `hr_recruitment` keys were unmarked, so a NON-HR override began routing to hr_manager
  instead of company_admin. Two causes: the panel conditions had been factored into
  `variables.local`, making them opaque to the self-scope classifier, and the classifier had no
  vocabulary for membership (`principal.id in attr.X`) regardless. Fixed by inlining the conditions
  and teaching both twin predicates the membership form — blast radius measured first: that form
  appears in exactly ONE resource policy, so no pre-existing role's classification moved.
- **`CAPABILITY-INVENTORY.md` drifted** once 8 MCP tools were added. Regenerated.

⚠ An earlier draft of this entry called the marker gap "not exploitable — the ceiling governs
granting, not acting." **That was wrong** — the marker also feeds override routing. Corrected rather
than deleted, because the wrong reasoning is the useful part.

#### The acceptance drive (added after the first pass, and it found two things)

`src/modules/hr/hr-full-acceptance.test.ts` — the whole department over REAL HTTP (`buildApp()` +
`app.inject()`, live Postgres + live Cerbos), following one employee end to end: configure →
requisition → candidate → interview → scorecard → offer → convert → payroll
calculate/ratify/approve/publish/pay → the subject reads their OWN published payslip → accrue leave →
separate → analytics. **19 assertions, 0 skips.** Handlers move PROTOTYPED → DEV-VERIFIED.

Two findings, both in the TEST rather than the code, and both worth recording because a green run
would have hidden them:

- **The fixture conflated the panelist with the hiring manager.** One user held both roles, so the
  hiring-manager rule granted `update` and the assertion "a panelist cannot reject a candidate"
  passed against the wrong rule — proving nothing. Split into two users; the panel arm and the
  hiring-manager arm are now proven separately.
- **The test's own arithmetic was wrong** on service years (asserted 1.75 for a 2026-10-01 →
  2027-06-30 span, which is nine months). The engine said 0.746 and the engine was right.

#### Seeding — `npm run seed:hr-config`

Holiday calendar (Indonesian 2026 incl. *cuti bersama*), three leave policies encoding UU 13/2003
art. 79, the 9-stage funnel, 7 pay grades, 6 allowance types, all five BPJS programs as SEPARATE
plans, and an UNRATIFIED statutory parameter set. Idempotent (proven to a third run) and asserted to
write **zero personal data** — which is what lets it run pre-Gate-1.

#### DEPLOYED — `alpha-01.071.0150a`, 2026-08-24 10:05 UTC

Live on `erp.gaiada.online`. Evidence from the deploy job's own log, not from the green tick:

- **6 database backups taken BEFORE any migration** (gaiada_platform, knowledge, keycloak, n8n, bot,
  waha-sessions).
- **All five migrations applied to the live database:** `202608240140_hr_time_and_lifecycle`,
  `…0141_hr_recruitment`, `…0142_hr_compensation_benefits`, `…0143_hr_payroll`,
  `…0144_iam_hr_full_permissions`.
- **Cerbos went `Restarting` and came back healthy** — it recompiles its whole policy repo at
  startup, so that transition IS the three new resource policies loading on the live PDP. The health
  gate now uses `ps -a`, so the crash loop this program hid once before would have been caught.
- `all services healthy` after the wait.

#### SEEDED on live — 2026-08-24

`seed:hr-config` run against the live database. Surveyed BEFORE (all eight config tables at zero;
23 employees / 41 records / 39 cases / 17 leave requests already present) and verified AFTER **as
superuser**, independently of the seed's own read — because a seed that reports success having
written nothing is this program's signature failure, and its own count is not evidence.

| | before | after |
|---|---|---|
| holiday calendar / holidays | 0 / 0 | 1 / 17 (15 public + 2 *cuti bersama*, both `deducts=true`) |
| leave policies / assignments | 0 / 0 | 3 / 3 |
| pipeline stages | 0 | 9 |
| pay grades · allowance types · benefit plans | 0 · 0 · 0 | 7 · 6 · 5 |
| statutory set / parameters | 0 / 0 | 1 / 24 |
| **employees · records · cases · leave** | **23 · 41 · 39 · 17** | **23 · 41 · 39 · 17 (untouched)** |
| candidates · compensation · payslips · requisitions | 0 | 0 (zero personal data written) |

The vacation policy landed as `upfront / 5760min / wait=12mo` — UU 13/2003 art. 79. Sick and unpaid
are `none`, because Indonesian sick leave is a paid-wage rule and not a counted entitlement.

**Idempotence proven ON LIVE, not just in a test:** a second run created nothing (`existing=` for
every section) and every count was identical afterwards. That matters because this seed will re-run
on future deploys.

**The statutory set is UNRATIFIED** (`ratified_by=NULL`), confirmed by direct query. Payroll
calculates against it and refuses to finalize without a recorded override.

⚠ **A concurrent session's release commit swept this work in.** `c4f6198` is titled for that
session's agent/bot changes but contains all 59 HR-FULL files. The tag `alpha-01.071.0150a` is
therefore accurate about the code and misleading about the subject — worth knowing when reading the
history. `docs-map` went red on it (MAP.md is filesystem-derived and was not regenerated); fixed in
`c22ea0e`.

#### Flagged, not resolved

1. **The statutory set is UNRATIFIED on live.** Payroll calculates but refuses to finalize without a
   recorded override. Finance/counsel ratifies in-app from `/hr/settings` (company admin, high
   assurance) once the PPh 21 / BPJS / PTKP figures are confirmed.
3. **The statutory figures are UNRATIFIED.** They express the structure of PP 58/2023 and PP 35/2021
   and are not legal advice. The engine hard-codes nothing, every run records the set it used, and
   finalizing against an unratified set demands a permanently-recorded override — that is the
   employee-portal §6 gate, re-expressed as data so the engine could be built without waiting on it.
4. **Payroll sequencing overrides a written plan.** `employee-portal-foundation.md` §6 assigned the
   engine elsewhere. Owner-directed, recorded in the migration header rather than left for a future
   reader to discover as a contradiction.
5. **No seeds** for calendars, policies, pipeline stages or a parameter set. Every affected surface
   renders an empty state that says what is missing instead of inventing a default.
6. **The `HR` nav entry remains ungated**, predating this work. The two money tabs are
   capability-gated inside the console, so this does not widen it.

### platform-nest `0.37.0` + platform-ui `0.48.0` — 2026-08-24 — client-centric ERP, slice 1: the client hub + the `clientId` facet (CC-01..03)

**Status: DEV-VERIFIED** (browser-driven against a DEMO_MODE build; the SQL additionally validated
against the LIVE estate before deploy). Design: `docs/plans/2026-08-24-client-centric-erp-design.md`.
Contract: `docs/FRONTEND-BFF-CONTRACT.md` §22.

Owner ask: read the ERP client-first — tasks, projects and everything else shown and filtered to the
client. The measurement that shaped the design: **`client_id` is already on 12 tables, so no new
columns were needed** — what was missing was the read surface. And **26 of 71 tasks / 9 of 20 projects
have no client at all**, so "everything starts with a client" needed an explicit answer for the
clientless third of the estate rather than a filter that quietly loses it.

**The finding worth keeping:** the client portal has always shown a client everything they own on one
surface, while `/clients/[id]` on the staff side showed contacts and a calendar and none of the
client's work — **staff had a worse client-centric view than the client did.** This slice is the staff
mirror of `/portal`.

#### Added
- **`core/client-filter.ts`** — the `?clientId=` facet: absent / `<uuid>` / `internal`. `internal`
  resolves to `client_id IS NULL`, **not** `is_internal = true`: the two disagree on the live estate
  (9 clientless projects, 7 flagged) and keying on the flag would leave 2 projects reachable from no
  scope at all.
- **Facet on `GET /projects`, `GET /pm/tasks`, `GET /invoices`** — all additive; omitting the
  parameter is unchanged behaviour. The task facet joins through `projects` (no `pm_tasks.client_id`,
  by decision) and turned out cheaper than designed: that CTE already joins `projects`.
- **`GET /:t/clients/:clientId/overview`** — the hub aggregate, one round trip, mirroring
  `/portal/overview`. Carries **`needsUs`** alongside `needsClient`.
- **`/clients/[id]` hub** — Overview + Work tabs, tab strip, `clientHub.css`. The former client page
  moved verbatim to `/clients/[id]/details`; nothing was deleted.

#### Fixed
- The client page fetched **every project in the tenant** and narrowed in the browser — which stops
  being a filter past one page of rows. Now server-side.

#### Notes / non-obvious
- **The facet is a CONVENIENCE FILTER, not a boundary, and both files now say so pointing at each
  other.** `portal-scope.ts` fails CLOSED (an external client must not reach another's rows); this
  fails OPEN (a bad value shows everything), because a filter that fails closed hides real work and
  looks exactly like "there is nothing here". Merging them into one "client scope" abstraction is how
  a filter silently becomes load-bearing for isolation — pinned by a unit test that says so.
- **`needsUs` is the reason the aggregate exists.** Nothing in the ERP rendered it before, which is
  precisely how a client-recorded payment sat `pending` with no screen saying anyone had to confirm
  it. Verified on the live estate: Nusa Coffee Co has **2** items waiting on us (an IDR 10,000,000
  payment awaiting confirmation, one untriaged change request) against 7 waiting on the client.
- The aggregate runs with `{ modules: ["social"] }`: the post-review join carries the `social` third
  wall and without the scope that SELECT returns **zero rows and raises nothing** — the hub would have
  reported "no post reviews outstanding" for a client with ten.
- Unlike the portal layout, the hub layout lets a fetch failure **throw**. A hub rendering zeroes tells
  a manager their client has no work, nothing owed and nobody waiting; this is the screen people act
  on, so an empty state must mean "empty", never "we could not ask".
- Demo fixtures mirror the facet, `internal` included. A fixture that ignored `?clientId=` would make
  every client-scoped surface look right in DEMO_MODE while showing the whole tenant — and would have
  lit up the Work tab's data-integrity card with other clients' tasks.

#### Known gaps (tracked, not implicit)
- The **six endpoints that already had `clientId`** (`deliverables`, `contracts`, `pipeline/runs`,
  `meetings/recordings`, `webdev/change-requests`, `social/*`) accept a uuid only — `internal` matches
  nothing there. Slice 2.
- **No facet yet** on `invoice-payments` or `time-entries`; **no `/approvals` list endpoint exists**.
- **Still no staff write UI** for contracts or payment confirmation (§16e). This slice makes both
  VISIBLE in `needsUs`; the Commercial tab that calls `send`/`countersign`/`decide` is slice 2.
- Slices 3-5 (Delivery / Requests / People tabs, the staff timeline, `<ClientPicker>` on the
  object-first lists) are PLANNED.

#### Gates
`tsc --noEmit` clean in both projects · `lint:withtenants` + `lint:migration-rls` OK · 9 unit tests
for the filter (incl. the fail-open contract) · **10 real-DB tests** for the facet and the money
math, run against a live test Postgres · platform-ui **172 files / 2795 tests** green ·
`DEMO_MODE=1 next build` green with all three hub routes · Playwright drove the hub in a browser.
No migration in this slice.

### platform-ui `0.52.0` — 2026-08-25 — GM console: the narrowed department-lead view (GM-02b)

**Status: PROTOTYPED.** Driven in a browser against a DEMO_MODE build; not against live platform-nest.
Tracking doc: [`../plans/2026-08-24-gm-console-PROGRESS.md`](../plans/2026-08-24-gm-console-PROGRESS.md).

**The headline is a corrected assumption, not a feature.** GM-02b was parked as blocked: "the UI cannot
identify a department lead" — `Me` carries no position or leadership signal and the P2-05 reconciler is
unbuilt. All true, and all irrelevant. `reports.department.view`'s own declaration in `CAPABILITIES`
reads *"department-grain (Cerbos `read_department`) — **SERVER narrows to the led unit subtree**"*. The
console asks for department grain and Cerbos decides which units come back; determining leadership in
the browser would have been precisely the "second opinion" the mirror rule forbids. **The blocker was
created by reaching for the wrong mechanism.** Worth generalising: when a UI blocker is "we cannot
determine X about the principal", check whether the server already determines X and narrows for you.

- `lib/gm.ts` — `gmAccessFor` returns `full` / `narrowed` / `none`. Company tier checked FIRST, so a
  principal holding both capabilities is not narrowed by the more specific-sounding check. Still
  company-scoped, so a `manager` of one tenant cannot read another's departments by editing the URL.
- `GmCockpit` — a narrowed lead gets **no company read at all** (not requested, not
  requested-and-discarded: firing it would log a guaranteed 403 per page view and invite a future
  refactor to render whatever came back), a banner stating the absence, provenance sourced from
  whichever read answered, and the period toggle **relocated** onto the Departments card — it normally
  rides the company card, so without the move a narrowed reader would have no route to a month view
  except hand-editing the URL.
- `gmTab.tsx` — `companyGrainOnly` opt-in and a third refusal state. The Business Review uses it and
  refuses with its own wording; "limited to group executives" alone would imply the reader does not
  belong in the console at all when every other tab is theirs.
- New **manager-tier demo identity** (`manager@gaiada.com` -> `dept-manager`, exactly one `manager`
  grant) + a `manager` row in `e2e/personas.ts`. An authorization tier that cannot be driven is a tier
  nobody verifies — neither `demo-hansel` (full) nor `gede-ic` (refused) exercises this one.
- `demoReports.ts` — **the fixture denied department grain to every non-superadmin** (`elevated =
  userId === "demo-hansel"`), contradicting §8. Fixed *including the narrowing*: a `LED_UNITS` map means
  the manager sees one department where the GM sees five. All-or-nothing would have let the narrowed
  console look correct while never exercising the behaviour it is built on.
- e2e 18 -> **25 tests**, all green.

**Two deliberate expectation flips**, both recorded in their test bodies so neither reads as a
regression to "fix" back: `gm.test.ts`'s "refuses a department manager" became "admits a department
manager — narrowed", and the e2e `REFUSAL` regex tightened from `/limited to group executives/i` to the
denial's distinctive opening clause — the loose pattern matched the narrowed banner and the
company-only refusal too, since that phrase is the true boundary in all three cases. Three states need
three distinguishable strings.

**GM-09 (the money tier) is deliberately still blocked.** The only cost data in the estate is
per-engagement search-marketing spend, so a "group spend" endpoint built on it would produce exactly
the misleading figure OQ-3 ruled out. That is a **data** gap needing an owner ruling, not an
endpoint-writing chore; writing it first would move the ambiguity into the backend.

### platform-ui `0.48.0` — 2026-08-24 — GM console: the four remaining tabs + an e2e suite (GM-05..08, GM-10)

**Status: PROTOTYPED.** Driven in a browser against a DEMO_MODE build; not against live platform-nest.
Tracking doc: [`../plans/2026-08-24-gm-console-PROGRESS.md`](../plans/2026-08-24-gm-console-PROGRESS.md).

- **Business Review** (GM-05) renders the company-grain `ReportDocument` through the EXACT stack
  `/reports/company` uses — `ReportPageClient` + `CompanyCharts`. No adapter and no bespoke exec
  layout, so a figure read here and a figure read there cannot diverge. Defaults to the WEEK (OQ-2)
  where the reports page defaults to the month. `periodKind` (the viewer's own selector key) wins over
  the console's `?period=` shorthand — backwards, and every selector change would be overwritten by
  the shorthand still in the query string.
- **Decisions** (GM-06) widens the existing `getMyWorkQueue` projection rather than fetching approvals
  again — `projectQueueForCompany` is a pure filter, so two projections cannot disagree. Adds wait-age
  bands (5d / 14d) and surfaces BOTH envelope incompleteness signals: `included: false` ("you saw none
  of this company") and `partialSources` ("you saw some of it and a named source failed" — the quieter
  and more dangerous one on a queue). Deliberately links out instead of wiring decide buttons: a third
  write path onto the same records is three surfaces to keep in step.
- **People** (GM-07) reads seats + compliance + appraisal cycles. New BFF surface:
  `getCheckinCompliance` + `CheckinCompliance`/`CheckinComplianceRow` + the pure `rollUpCompliance`.
- **Clients & Money** (GM-08) ships the portfolio half real (a clients × live-projects join) and the
  money half honestly absent behind a `BackendPending` banner naming SM-17/SM-22.
- **GM-10** — `e2e/gm-console.spec.ts`, 18 tests, own `gm` Playwright project, all passing. The
  negative controls are the point: a plain member must be refused on the cockpit AND all five tabs,
  the refusal must not look like an empty business, and the GM row must STAY in that member's sidebar.
  Those paths leave every vitest green if they break — only a browser catches them.
- New DEMO_MODE fixtures for `/checkins/compliance` and `/positions` (the latter did not exist at all,
  so the seats card rendered its failed-read branch).

**Four findings worth carrying forward**

1. **A calendar-week compliance figure is structurally useless on a Monday.** Measured: the first
   render returned an empty grid because the week had barely started — true and useless. Compliance now
   reads a TRAILING window (7/30 days ending today), and `GmProvenance` grew an explicit `label`
   because calling a trailing 7 days "This week" would misstate which days were counted.
2. **`listPositions` swallows its own errors** and returns `{positions: [], scope: null}`, so a refused
   read is indistinguishable from a company with no seats. `scope === null` is the only failure signal;
   keying the empty branch on `positions.length` would have made the console claim something it cannot
   know.
3. **`GET /checkins/compliance` does not 403 a plain member** — it degrades to a one-row self grid. So
   `rows.length === 1` is not an error, and a consumer must not present a self-only grid as a team
   view. Recorded in the BFF contract alongside the `unit`-echo and `complianceRate: null ≠ 0%` rules.
4. **A pre-existing duplicate-React-key warning lives in the app shell**, firing on `/timesheets` and
   Web Dev's console home — pages this work never touched. Chased far enough to exonerate the nav
   change (`navFor` has no duplicate hrefs within a group and no duplicate group labels). Left unfixed,
   recorded so nobody re-chases it from here.

### platform-ui `0.47.0` — 2026-08-24 — GM console: the cockpit, the gate, the Departments tab (GM-01..04)

**Status: PROTOTYPED.** Driven in a browser against a DEMO_MODE build (cockpit, all five GM tabs,
both themes, the member-refusal path and the wrong-department path); not driven against live
platform-nest, and no e2e spec added yet.

Design: [`../blueprints/gm-console-foundation.md`](../blueprints/gm-console-foundation.md).

**What landed**

- `lib/deptToolkits.ts` — a `gm` toolkit: `Home · Project Management · Command · Oversight ·
  Connections`. Two craft groups rather than one (SEO's D-10 precedent) because five tabs under one
  group is a flat list with extra steps. No GitHub/Figma/VS Code launchers — the GM does not produce.
- `lib/gm.ts` — the gate, the period vocabulary, the Tier-1 cap, keyed on the department NAME slug so
  every company in the holding resolves its own GM node.
- `components/departments/gm/` — `GmCockpit` (Tier 1 company KPIs + Tier 2 department strip),
  `GmDeptStrip`, `GmProvenance`, `GmAccessDenied`, `gmTab` (the shared two-check guard).
- Five routes under `app/(app)/departments/[deptId]/`: `depts` is real (GM-04); `review`,
  `decisions`, `money`, `people` are honest stubs naming GM-05..08. Routes exist so the toolkit
  cannot point at a 404 — the registry's own standing rule.
- `components/shell/nav.ts` — GM hoisted to the top of `Departments` (see
  `../sidebar-nav-map.md`). **No route moved.**
- `lib/org.ts` — a GM department in the seeded/default agency structure, appended so the positional
  `dept-N` ids stay stable.

**Two findings worth carrying forward**

1. **`rollups.view` is held by NO role bundle except `platform_admin`'s wholesale `ALL`.** The design
   doc's first draft said reuse it for the GM gate (it gates `/rollups` and, in `nav.ts`, the Company
   Report row). Measured against `ROLE_CAPS`, that would have refused `company_admin` — the tenant's
   own administrator, who holds the whole `EXEC_ONLY_REPORTS` tier — while the backend served the
   same figures at `/reports/company`: a UI gate hiding a page the server would serve. The gate is
   `reports.company.view`, the capability that names the actual §8 boundary, and it is company-scoped
   so a `company_admin` cannot read another tenant's cockpit by editing the URL.
2. **The cockpit hardcodes no metric keys.** Tier 1 and Tier 2 both render whatever
   `reports/overview` returns for the grain, capped for cognitive load, with columns derived from the
   union across scopes. The design sketched six named north stars; implementing that literally would
   have hardcoded keys against a registry this console does not own — the frontend-first drift class.
   `KpiTiles` is reused as-is, so formatting, denominators, point-in-time labels and delta chips
   cannot drift from the reports surface.

**Deliberately honest gaps** — the money tier has no backend at all (no tenant-level MTD spend or
margin endpoint; only per-engagement `ledger`, owned by SM-17/SM-22), so `money` carries a
`BackendPending` banner and never a zero; and one department's provider spend must not be summed into
a group figure. OQ-1's narrowed department-head view is tracked as **GM-02b**, blocked on the UI
having any way to identify a unit lead (`Me` carries no position/lead signal and P2-05 is unbuilt) —
guessing would ship a leak, so a dept head currently gets the same refusal a member does.


### social-media `0.5.31` — 2026-08-23 — correcting how SMM-35's agent gate actually works

**This corrects the mechanism `0.5.30` claimed, not its outcome.** That entry said no real LLM can
drive `social.createReplyDraft` unattended "until an operator runs the D13 eval + enrolls it".
Verified against the code, that is **not what gates it**:

- `evaledProviders` is **detective, not preventive**. `ai-agents/src/obs/collector.ts`'s own header
  says it "closes a DETECTIVE half of the D13 failover gate"; `writesOnUnevaledProvider` feeds the
  `agent_writes_on_unevaled_provider` gauge. Nothing refuses a write because a provider is unenrolled.
  So `evaledProviders: []` **counts** such writes; it does not stop them.
- The hub's suspension does not apply either. `mcp-hub/src/policy.ts` suspends
  `isUnattended && write && impact !== "low"`, and `social.createReplyDraft` is declared
  `impact: "low"` platform-side — the refusal message itself reads "only low-impact writes run
  unattended". So an unattended agent holding this tool creates a draft row **without any approval**,
  by design.

**What IS true, and what actually makes it safe.** Two separate gates on two separate surfaces, both
intentional and both mirroring the established `taskFiler` precedent:
1. **Via `/assistant`** — `high_write` in `ai-agents/src/specialists.ts` forces the ASST-23 confirm,
   then approve, then D14 execute. Preventive, and evidenced by `0.5.30`'s card-state test.
2. **Via the hub, unattended** — no approval, because the write's blast radius is genuinely low: it
   inserts one `social_inbox_messages` row at `status='draft'`, never sent, never network-visible,
   never client-visible. That is the real safety argument, and it is a sound one.

The `high_write`-on-hub-`low` divergence is deliberate: `high_write` answers "may this run without a
human confirming from a chat turn?" (D-A: no, always), which is a different question from the hub's
impact tier. Both classifications are correct for their own surface.

**Why this correction matters more than the wording:** a reader who believed enrollment was
preventive would reasonably add a second unattended agent write and expect the same non-existent
gate to hold it. The honest rule is that **blast radius is the gate for unattended agent writes**, and
`evaledProviders` only tells you afterwards that an unenrolled provider did one.

**Unchanged:** all code, all tests, all figures from `0.5.30`. This is a documentation correction only.

### social-media `0.5.30` — 2026-08-23 — closing SMM-35's remaining half: one social write reachable from `/assistant` (senior-be)

**Added** — the assistant's "social summary" READ landed a pass ago (SMM-35); this pass exposes exactly
ONE social WRITE through the SAME ASST-23 propose -> confirm -> approve -> D14 chain, deliberately not
the publish/reply-send tools. Blast-radius argument: `social.createReplyDraft`
(`social.controller.ts#createReplyDraft`, SMM-17) only ever inserts OUR OWN draft row — never sent,
never network-visible, never client-visible — the same "agents draft, never publish" shape SMM-26
already established for content briefs. `social.publishPost`/`social.publishPostMetered`/
`social.sendReply` stay excluded on SECURITY grounds (a chat "confirm" click is not a more scrutinized
gate than the existing approvals-inbox review for a public, irreversible act) — unchanged from SMM-35's
own prior "no". `social.draftContentBrief` stays excluded too — still blocked on the SAME cross-repo
`ai-agents` AgentDef + D13 eval-enrollment gap SMM-35 named, and `content-brief.ts` is a concurrent
seat's file this pass could not touch regardless.

New `core/approval-executables.ts` SMM-35 section: `registerSocialReplyDraftExecutableApproval()`
registers `social.createReplyDraft` with a real, self-declared-scope precondition (thread exists ∧ not
soft-deleted ∧ a non-empty body was proposed — typed refusals `reply_thread_missing`/`empty_body`/
`reply_thread_not_found`) and `neverAutoRetry: true` (a CREATE mints a fresh id per call, so an
in-executor auto-retry after a lost response would duplicate the draft, not re-apply it — independently
derived from publish/reply's own reasoning, not copied). New MCP tool `social.listThreadMessages`
(`index.ts`) — a read-only wrapper around SMM-17's pre-existing `GET threads/:threadId/messages`
verification endpoint, declared as a tool for the first time because the new agent needs to see a
thread before it can draft an answer to it.

New `ai-agents/src/specialists.ts` AgentDef `social-drafter`: `social.listThreadMessages` (read) +
`social.createReplyDraft` (`high_write` — the SAME honest divergence from the hub's `low` tier
`task-filer` already established: the hub tier answers blast radius, the AgentDef label answers "may an
LLM commit this unattended", and D-A's answer is no, always). `evaledProviders: []` — the same safe
default `task-triager`/`task-filer` shipped with before their own dedicated eval runs; reads work today,
the write is CONTAINED (not merely undeclared) until an operator runs the D13 eval suite against a real
provider. New eval cases (`evals/cases.ts`): a read-only happy path, a proposes-createReplyDraft case,
and an adversarial containment probe (injected thread text cannot trick the agent into calling
`social.sendReply`, which is entirely off its allow-list). `agent-write-guard.test.ts`'s
`RERUN_CAPABLE_HIGH_WRITES`/`ASSISTANT_FACING_AGENTS` allowlists extended, by name, with both
prerequisites cited.

**Reachability proven, not merely registered.** New
`platform-nest/src/core/d14-smm-35-social-reply-draft-registry.test.ts` (14 tests: registry doctrine,
lockKey, the precondition direct including the module-GUC regression, and the real executor —
positive control, single-use, no-auto-retry) driven red-then-green: with the registration temporarily
disabled, all 14 fail on the tool's own absence (`no_precondition_registered`, the D14-02 fail-closed
fallback); restored, 14/14 green. A new card-state test in `assistant-broker.test.ts` mirrors the
existing `pm.createTask` one verbatim for `social.createReplyDraft` — a real thread seeded, a suspended
`origin='agent'` approval decided through the REAL `POST .../automation-approvals/:id/decide` endpoint
and executed through the REAL executor, showing EXECUTED on a fresh `GET thread` — proving the surface
end to end from the assistant's own HTTP boundary, not just the registry in isolation. That test's own
setup surfaced and fixed a real hygiene bug in a PRE-EXISTING test in the same file: its "step 0.5"
registry-gate test calls `resetExecutableApprovals()` (a process-wide singleton) and its own `finally`
only restored the PM entries it knew about at write time, silently unregistering
`social.createReplyDraft` for every test after it in file-declaration order — fixed by also restoring
the social entry there.

**Test counts, measured directly.** `platform-nest`: the new registry file 14/14; `src/modules/social`
+ `src/modules/assistant` + every touched D14 registry/executable file together (58 files, 862 tests):
**860 passed, 0 failed, 2 skipped** (`assistant-real-gateway.qa.test.ts`, a pre-existing live-gateway
skip, unrelated). One transient "tuple concurrently updated" DB-role-creation flake on
`reply-dispatch.test.ts` when run in a smaller, separate invocation — re-run alone, 6/6 green,
confirmed as the shared-test-Postgres phantom-failure class this program's own docs name, not a
regression. `tsc --noEmit` clean. `lint:withtenants`/`lint:migration-rls`/`lint:migration-names`/
`lint:postiz-deps` all green (no migration — still 138 files). `test:iam-chain-alignment` **25/25**
(unaffected — no new permission key, no Cerbos policy edit; `social.listThreadMessages` reuses the
existing `social_inbox`/`read` action). `ai-agents`: full suite **204 passed, 0 failed, 53 skipped**
(pre-existing DB-dependent skips, untouched by this pass) — `agent-write-guard.test.ts`,
`impact-reconciliation.test.ts` and `evals/harness.test.ts` all updated and green with the new agent.

**Scored against the agentic-native bar.** Human: a staff member chatting with the assistant can now
have it draft an inbox reply, review the proposal, and send it for the SAME approvals-inbox review any
other write gets — DEV-VERIFIED via the card-state test. n8n: unaffected — this ticket touches only the
assistant's own agent-runner path, not the automation/n8n filing path, which already had
`social.createReplyDraft` reachable via the plain HTTP endpoint before this ticket. Agent: PROTOTYPED,
not DEV-VERIFIED — the platform-side chain (propose/confirm/decide/execute) is proven against a
SCRIPTED fake runner, never a real model; `socialDrafter.evaledProviders` is empty on purpose, so a
REAL LLM cannot yet drive this path unattended until an operator runs the D13 eval + tool-contract
suite against a live provider and enrolls it — named as the remaining, deliberate gap, not a silent
skip.

**What stays out of scope, named rather than silently decided:** (1) `social.updateReplyDraft`/
`social.approveReplyDraft` are NOT given to `social-drafter` — a second/third write per turn multiplies
the registry/eval/allowlist surface for no new capability this pass needed to prove; a natural follow-up
once `social.createReplyDraft` has a real enrolled provider. (2) The D13 eval-enrollment run itself (a
live model call against the shared, weekly-rate-limited Ollama Cloud quota) was judged out of bounds to
spend unilaterally, per this program's own standing note on that resource — an operator decision, not a
platform-nest ticket's. (3) No UI change: the composer's agent picker already sources from
`GET .../assistant/capabilities`'s `toolAgents` generically (ASST-18), so `social-drafter` appears there
with zero FE code — not verified in a real browser this pass (backend-only ticket; platform-ui unrelated
files, no change).

### social-media `0.5.29` — 2026-08-23 — the content-brief weekly sweep's automation identity (SMM-26 follow-up)

**Added** — closes the follow-up SMM-26 named and left for an architect decision (found by SMM-26's
own MCP-surface audit; `docs/plans/smm-tracker.md`'s SMM-26-follow-up row): "the v1.0 design's
'weekly per opted-in engagement' scheduled sweep for the content-brief flow was deliberately NOT
built — needs an architect decision on an automation service identity before a principal-less job
can legitimately call WS8's per-principal-scoped RAG search." The owner authorised minting a
dedicated automation principal (`platform-nest/CLAUDE.md`'s own standing rule: automation/bot
principals are rows in `users`, never a second principal table).

**The identity: ONE automation principal PER TENANT, never one global principal — tested, not
assumed.** New `src/seed/social-content-brief-automation.ts` (`ensureContentBriefAutomationPrincipal`/
`findContentBriefAutomationPrincipal`). WS8's own `/search` predicate
(`ai-agents/src/knowledge/store.ts#search`, read directly) is `tenant_id = ANY(callerTenantSet) AND
(acl = '{}' OR scope = ANY(acl))`, with NO per-call `tenantId` parameter narrowing `callerTenantSet`
(`principal.companies`, resolved from ACTIVE `company_memberships`) back down. Every internal-tier
document defaults to `acl = '{}'` — "readable by any member of the tenant"
(`docs/modules/knowledge/README.md`'s own table: not only the brand corpus, but clients, projects,
tasks, meetings, reports, org structure, files). A single global principal holding memberships across
every opted-in tenant would therefore be a candidate, on ANY one tenant's sweep call, to retrieve
EVERY OTHER opted-in tenant's entire internal ERP corpus — exactly the "automation identity that can
read every tenant's corpus is worse than no sweep" failure this follow-up was told to avoid. Each
tenant instead gets its OWN `users` row holding EXACTLY ONE active `company_memberships` row, so its
resolved `companies` (and so WS8's `callerTenantSet`) can never contain a second tenant BY
CONSTRUCTION — proven directly against a real `assemblePrincipal()` call
(`social-content-brief-automation.test.ts`, 6/6), not merely argued. Least privilege: no role grant,
no Cerbos policy edit, no permission-catalog entry (`docs/PERMISSION-CONTRACT.md` untouched) — this
principal never passes through Cerbos, only WS8's OBO principal lookup, because the sweep calls
`runContentBrief` in-process, the same "scheduled sweeps are platform-nest jobs, not permissioned
endpoints" precedent `inbox-sync-job.ts`/`inbox-triage-job.ts`/`best-time-job.ts` already established.
`users.home_company_id` is deliberately left NULL — this principal has no root-gated Cerbos rule to
anchor, and WS8's tenant-set reads `company_memberships`, never `home_company_id`.

**The sweep itself:** new `src/modules/social/content-brief-job.ts`
(`pullTenantContentBriefSweep`/`runContentBriefSweep`/`startContentBriefSweepLoop`), dark by default
via `config.social.contentBrief.weeklySweep` (a HARD gate, not a perf opt-in — it spends
`ai-gateway-go` calls per opted-in engagement), wired in `main.ts`. Opt-in lives on
`social_engagements.tool_scope.ai.autoWeeklyBrief` (additive jsonb key, no migration), and defaults
to **false** on absence — the opposite polarity from `ai.drafting`'s own absent-defaults-true, since
an unattended weekly draft spending gateway calls with nobody watching needs an explicit,
affirmative opt-in. The sweep LOOKS UP, never mints, the per-tenant principal: an opted-in
engagement whose tenant has none provisioned is counted `principal_not_provisioned` — a fourth,
distinct fact from "never opted in", "opted in but nothing to brief", and "drafted"
(`content-brief-job.test.ts`, 6/6, proves the refusal writes zero rows to `social_posts` and never
calls the gateway).

Full detail: `docs/plans/smm-tracker.md`'s SMM-26-follow-up evidence block.

### platform-nest `0.36.1` — 2026-08-23 — `seed:owner-grant`, and a lockout found on the estate

**Fixed**
- Production had **1 platform_admin and 0 owners**, so IAM-16's two-person appointment (D-9: one
  superadmin + one owner) was unsatisfiable — no elevated appointment was possible through any
  supported flow. The arithmetic had been checked in the REPO, where `seed:agency` grants Anthony
  `owner`; the estate has never run that seed. A seeded fixture is not a deployed principal.
- `seed:owner-grant` creates the owner and grants `owner` per company on the three companies that
  exist. Creates no companies (owner decision) — the Viceroy venues and Bali Catering stay separate.
- Also corrects two false claims about production in the previous release's seeds, and the blind
  check behind both: `set_config(..., true)` inside `withGlobal` is a no-op (no transaction), so
  every RLS-guarded count read zero and reported success.

### social-media `0.5.28` — 2026-08-23 — brand-corpus provenance is derived, not asserted

**Fixed (RAG integrity)** — `ingestBrandKnowledge` sent a literal `provenance: "human"`, commented
"caller-supplied approved content, not agent-generated". That claim was unfounded: the endpoint accepts
arbitrary `body.chunks`, and `social.ingestBrandCorpus` is an MCP tool that **executes unattended**, so
an agent could submit its own output and have it stamped as human authorship.

**Why this is more than a wrong label.** WS8 scores retrieval as `cosine × confidence × provenance
factor`, and `ai-agents/src/knowledge/store.ts` sets `confidence = provenance === "agent" ? 0.6 : 1`.
Agent text mislabelled `human` therefore **outranks genuine human brand guidance** in the very
retrieval that grounds the next AI draft — a self-reinforcing loop that degrades the corpus every
cycle with nothing visible from the outside. Provenance is now **derived** from the caller and the
parameter is required with no default, so `tsc` names any new call site rather than letting it inherit
the dangerous value.

**⚠ The rule is allow-list shaped, and my first version of it was wrong in the harmful direction.** I
initially wrote `assurance === "low" ? "agent" : "human"`, reasoning from "automation principals are
minted assurance low". But `auth/guards.ts` mints only two levels for a real caller — `"high"` on the
interactive path (IdP JWT, or `x-user-id` in dev/tests) and **`"linked"` on the OBO envelope path,
which is how an agent calls**. An agent arriving through a verified identity link is `"linked"`, so
that rule would have stamped its output `"human"` and left the defect fully intact while appearing
fixed. The rule is now `assurance === "high" ? "human" : "agent"` — only `"high"` earns `"human"`, so a
future assurance level added to the union defaults to the safe answer instead of the harmful one.

**Flagged, not taken unilaterally** — the stronger fix is an assurance FLOOR on the endpoint (`notLow`,
per `rbac/can.ts`): every successful ingest would then be provably human and the agent path closed
outright rather than down-weighted. That removes an existing agent capability, which is a product
decision rather than a defect fix, so it is the owner's call. **Known cost of the current fix:** a
non-interactive caller's genuine guidelines are ingested at agent confidence (0.6).

**Tests** — `social-ai-drafts.test.ts` 12/12 (+2). The fake WS8 fixture now records the claimed
provenance, not just the text; a fixture that drops that field cannot catch this direction at all.
Proven red-then-green by reintroducing my own deny-list mistake: the `"linked"` assertion fails with
`expected 'human' to be 'agent'`. `src/modules/social` 579/0/0 (37 files).

### social-media `0.5.27` — 2026-08-23 — the publish "approve variant" endpoint (SMM-40)

**Added** — closes the last open follow-up `docs/plans/smm-tracker.md` named (found by SMM-17):
nothing in this codebase ever MINTED the one-shot `automation_approvals` grant `social.publishPost`
was already registered against (`core/approval-executables.ts`'s SMM-09 section — real `lockKey`,
real `precondition`, `neverAutoRetry`, all pre-existing). Without a filed row, `dispatchPublish`
could never resolve an `executing` approval and D-6 (`publisher/direct.ts`) refused every dispatch
outright.

**`POST /api/:tenantId/modules/social/variants/:variantId/approve`** (`social.controller.ts`,
Cerbos `publish` on `resource_social_post.yaml` — the SAME manager-tier action `dispatchPublish`/
`dispatchMeteredPublish` already require; NO new permission key). Flips the variant to 0105's own
pre-existing `'approved'` status value (which the ALREADY-registered precondition's `unconsumed`
stage already required and nothing had ever written) and files the `automation_approvals` row —
`origin: 'agent'`, a snapshot of `variantPublishArgs` as `tool_args` — reusing
`core/approval-filing.ts`'s `insertAutomationApprovalRow`/`notifyApprovalFiled`, never a third copy
of that INSERT. Idempotent on an EXACT content match (a live grant for a DIFFERENT, since-edited
snapshot of the same variant is never returned — see the fix note below). Deciding is a SEPARATE
step through the pre-existing generic `POST /automation-approvals/:id/decide` — this ticket duplicates
no decide/execute logic; "approving executes" falls out of the registry entry that already existed.
New MCP tool `social.approvePostVariant` (`write:true, impact:'high'`, from the pinned
`SOCIAL_PUBLISH_TOOL_CLASSIFICATION`).

**The invalidation law is reused, not rebuilt.** `updateVariant`/`draftCaption`/`attachMedia` already
revert an edited variant's `status` to `'draft'` and recompute `args_sha256`; a variant this endpoint
approved, if edited afterward, reverts through that SAME path, and the minted grant's frozen
`tool_args` snapshot stops matching, so the pre-existing `hash` stage refuses `args_hash_mismatch`
at execution — no new column, no new invalidation code. Proven red-then-green: an edit-then-dispatch
attempt through the real executor refuses `precondition_failed: args_hash_mismatch` with the hub
asserted (not inferred) to have been called zero times.

**A real bug caught by the ticket's OWN idempotency test, fixed before landing:** the first draft of
the mint's dedupe check matched on `tool_args @> {variantId}` (containment) — meaning a live,
undecided-or-not-yet-executed grant filed against an EARLIER snapshot of the variant would be handed
back to a caller who had since edited the content, instead of a fresh grant against the new content.
Fixed to an exact `tool_args = $args::jsonb` equality, so only a grant matching the variant's CURRENT
content is ever considered "the same request" — `(D3)` in the new test file pins this in the failing
direction it was first caught in.

**A pre-existing, separate gap named rather than papered over:** `identity_links` is populated only
by the WhatsApp/Telegram dual-proof enrollment ceremony, never by an ordinary Keycloak/OIDC staff
login. `origin: 'agent'` is the correct D14 origin here (it re-drives at execution as the FILING
PRINCIPAL's own identity, never an n8n workflow's, which is what lets the SAME `publish` Cerbos check
`dispatchPublish` runs at execution time actually pass) — but a manager with no linked identity will
have their approval decided successfully and then fail EXECUTION with the pre-existing, correctly
typed `principal_unresolvable` refusal. Both the executing (linked) and refusing (linkless) paths are
proven in `social-publish-approve.test.ts`; this is an IAM/OIDC identity-linking gap, not a defect in
this ticket's own code, and is out of this ticket's scope to close.

New test file `src/modules/social/social-publish-approve.test.ts`, 15/15 green. Full regression
detail in `docs/plans/smm-tracker.md`'s SMM-40 evidence block.

### platform-nest `0.36.0` — 2026-08-23 — two targeted seeds: roster ACCESS, and the HR people file

**Added**
- **`seed:roster-access`** — users, company memberships, role grants and org-chart seats for the real
  roster, and nothing else. Written instead of running `seed:agency` because checking the live estate
  first showed it is deliberately CLEAN (3 companies, 53 users, 52 grants; zero
  clients/projects/tasks/invoices/memberships/positions). `seed:agency` is a full demo vertical —
  running it to give nineteen people a `users` row would have injected all of it. The suite's most
  important assertion is the negative one: the business-data tables must still be empty afterwards.
- **`seed:employee-files`** — `employees` rows for the roster. Migration 0109 created that table in
  Phase 2 and NOTHING had ever written to it. Kept separate from roster-access because access and
  employment are different claims: automation/bot principals are ordinary `users` rows by design, and
  `employees.user_id` is nullable so a `pending_start` candidate can exist before any account.

**Two traps these had to route around**
- `company_memberships` and `employees` are both RLS-walled, and `employees` needs the MODULE guc too
  (`app_module_allowed('hr')`). A write without it succeeds having written zero rows. The HR suite
  therefore reads the table twice — with and without `{ modules: ["hr"] }` — and asserts they
  DISAGREE; a reader that also forgot the scope would read zero and agree with a broken seed.
- Both scripts REFUSE if `Gaia Digital Agency` is absent rather than creating it. Creating a company
  by name is the fork that hit the resort (migration 202608230612).

**Deliberately left NULL:** `hire_date` (nobody supplied one; a fabricated HR date is worse than an
absent one) and `manager_user_id` (0109 §2.1 makes it an OVERRIDE of the org chart, not the reporting
line — the chart already answers that from the lead seats).

### platform-nest `0.35.1` — 2026-08-23 — the resort rename needed a migration, and one DELETE was RLS-blind

**Fixed**
- **`Sanur Resort` -> `Viceroy Bali` now renames IN PLACE** (migration `202608230612`). b48df97
  corrected the name in the seed and every suite passed — because each test file gets a FRESH
  database, so the seed created the resort from nothing. On an existing database `ensureCompany()`
  resolves BY NAME, finds no `Viceroy Bali`, and INSERTS: the live estate would have kept
  `Sanur Resort` with all its history and gained a second, empty resort holding the venues and the
  owner grants. Found by listing the live companies before running the seed. The migration preserves
  the id and children, and REFUSES if both names already exist — merging two companies is an owner
  decision, not something a migration may guess.
- **`DELETE FROM position_roles` had no tenant GUC.** Migrations run as `platform_owner`
  (NOBYPASSRLS) against a FORCE-RLS table, so it would have matched zero rows and reported success.
  Caught by `lint:migration-rls` in CI — I had run that linter earlier in the session, but before
  the migration existed. Affected rows were zero either way (the position_roles guard refuses the
  role by name), but a silently-empty DELETE is indistinguishable from a working one.

**Testing**
- `resort-rename.db.test.ts` seeds the OLD state by hand and asserts convergence. A fresh-DB
  assertion would pass with the migration deleted, which is precisely how this was missed. It
  executes the .sql directly rather than via `migrate()` — the harness repoints the app pool at
  NOSUPERUSER `platform_app_test`, so `migrate()` from a test hits "permission denied for schema
  public".

### social-media `0.5.26` — 2026-08-23 — OAuth state is bound to the principal who started it

**Fixed (security)** — closes the follow-up the previous pass named rather than absorbed:
`social_oauth_states.created_by` was stored for audit but never compared at consume time.
`consumeSocialOAuthState` now refuses `principal_mismatch`, the same A1 (login-CSRF) defence
`core/google-oauth/state.ts` has always had and this table always carried the column for.

**The attack it closes, and why Cerbos could not** — principal A starts a connect ceremony; principal
B, who *also* legitimately holds `connect` on that tenant and so passes the callback's own Cerbos
check, presents A's state and binds **B's** LinkedIn/YouTube account into the slot A was connecting.
Both principals are authorized to connect *something* there, so no permission check can see it. What
is wrong is the **swap**, and only the state row's own provenance can detect that.

**`principalUserId` is REQUIRED on the `expect` argument, not optional.** An optional field would let
a call site omit it and silently skip the comparison — an authorization check that reads as enforced
while enforcing nothing, a bug class this repo has hit repeatedly. Required means `tsc` enumerates
every call site that has to decide; it named all of them, and both real callbacks now thread
`req.principal.userId` through.

**Comparison is `?? null` on both sides**, so a state minted by a principal-less path stays consumable
by a principal-less caller, while a principal-bound row presented with `null` **refuses** — the
fail-closed direction, and the one that matters if a future call site forgets to thread the principal.

**Ordering documented honestly** — the atomic `UPDATE` claims the row *before* either binding check,
so a mismatched attempt has still **spent** the state and the rightful principal must restart the
ceremony. That is the safe direction (a state fed into a failed callback is exactly the one an
attacker would retry), and there is now a test asserting precisely that sequence rather than leaving
it as a surprise.

**Tests** — `oauth-state.test.ts` 15/15 (+5). Proven red-then-green: deleting the comparison turns
exactly three of the five red, while the two null-matching cases stay green — showing they are not
vacuous in the opposite direction either. Two fixture corrections were needed to get there and are
worth noting, since both would have masked the test: `created_by` is a `uuid` **with an FK to
`users`**, so string literals failed first on type and then on the constraint; the tests now create
real `users` rows. `src/modules/social` 562/0/0 (36 files).

### social-media `0.5.25` — 2026-08-23 — the metered-spend panel is finally browser-driven

**Added** — `e2e/social-console.spec.ts` +1 (14 total): SMM-22's usage panel was unit- and
type-checked only, so its ONE stated rule had never been observed in a rendered page — an UNSET
tenant cap (`capUsd: null`) is a different fact from a cap spent to zero headroom, and collapsing the
two would make an operator who never configured a tenant-wide cap believe one exists and is nearly
exhausted. `soc-eng-1` seeds all three tiers at genuinely different states (engagement 62%, below the
0.8 warn ratio; tenant UNSET; platform-wide 97.2%, above it), so one page proves the panel
*discriminates* rather than merely renders. Asserts the unset tier as prose, and — structurally —
that exactly TWO `progressbar`s exist, since a third would mean the unset tier had been given a bar,
which prose assertions alone would not catch. Also pins the real `aria-valuenow` values (62 / 97), a
computed-colour difference across the warn threshold, and that 97.2% does NOT trip the
"tier is exhausted" refusal — the assertion that catches a `>=` slipping in where `>` was meant.

**Fixed (test infrastructure)** — the spec is now **serial at file scope**, overriding the config's
`fullyParallel: true`. Every test drives the same DEMO_MODE store, which `lib/demoSocial.ts` pins to
`globalThis` and one dev-server process serves to all workers, so parallel tests mutate each other's
rows. The race was **latent, not absent**: this suite passed 8-worker parallel at 13 tests and failed
three Composer tests at 14 — adding a test shifted the timing, it did not introduce the bug. A suite
whose green depends on worker count is not evidence, so this trades ~35s of wall clock for a result
that means something.

**Measured** — 14/14, both 8-worker default config and `--workers=1`, in a clean detached worktree at
the merged commit, on a private `E2E_PORT`. That last detail is load-bearing: see the tracker's new
cross-session hazard on `reuseExistingServer`, which caused a false "regression on main" conclusion
earlier in this same pass before being traced to a foreign dev server on port 3005.

### platform-nest `0.35.0` · platform-ui `0.41.0` · ai-agents `0.8.0` — 2026-08-23 — IAM-15: `group_executive` is removed (D-7)

**Removed**
- The role's entire reach: **54 `group_executive`-only rules across 46 Cerbos policies**, its derived
  role in `derived_roles.yaml`, its 134-key bundle in `role-permission-bundles.json`, and its entry
  in `scope-constrained-roles.json`. Migration `202608230230` revokes every grant, drops the
  `role_permissions` / `position_roles` rows and deletes the `roles` row, then refuses to finish if
  the role still exists or any `user_roles` row is left orphaned.
- The seed no longer grants it. `exec@gaiada.test` stays a member of both companies — it is a
  long-standing fixture several suites resolve by email — but holds no exec role.

**Why it was safe now and not before**
- The estate's ONLY holder was that fixture. Checked before writing the migration, not assumed:
  narrowing authorization without knowing who holds the role is how an outage ships as a cleanup.
- Sequenced last on purpose. MON-00c had root-bounded the role behind `variables.inRoot` as interim
  protection, so removing it earlier would have discarded that work; and `owner` (IAM-14) had to
  exist first, because several of these rules were literally commented as the *owner* tier.

**Consequences worth knowing**
- Holding-wide oversight is now `owner`, granted per owned company. Nothing replaced the role for a
  non-owner — cross-company reach now needs a grant in each company. That narrowing is the ticket.
- The widest single loss was `integration_connection`: full CRUD on any tenant's rows in the root,
  including the credential vault. D-7's "last unrestricted cross-company business role" was not an
  abstraction — that rule was it.
- **`inRoot` is now nearly vestigial as a SOLE gate.** Exactly one live rule still uses it alone
  (`resource_rollup.yaml`'s `perm_rollup_read`); all 195 other uses are `inTenant && notLow &&
  inRoot`. `cross-root-boundary.db.test.ts` records the precision this costs it.

**Verified**
- Live PDP probe before/after: `group_executive` on `appraisal.read` went ALLOW → DENY while
  `platform_admin` stayed ALLOW (the control that proves the policy set loaded rather than failed).
- `cerbos compile` clean on the swept tree.

### social-media `0.5.24` — 2026-08-23 — `listComments` refuses a post id it cannot route

**Fixed**
- `direct.ts#listComments` infers the network from the post id's own format, because the publisher
  port carries no `network` parameter there. The `urn:li:` test is sound — LinkedIn's wire format
  mandates that prefix — but the fallback was *"anything that is not LinkedIn is YouTube"*, which is a
  weaker and different claim. The moment `0105` admits a third inbound network, that network's post
  ids would have been handed to the YouTube API. The likeliest result, an **empty list**, is
  indistinguishable from *"this post genuinely has no comments yet"* — the worst of the three possible
  outcomes, and precisely the absent-vs-zero conflation this module refuses everywhere else.
- Now fails closed: an id matching neither a LinkedIn URN nor YouTube's documented video-id shape
  (exactly 11 characters of `[A-Za-z0-9_-]`) is refused with `capability_unsupported`, and the message
  names *widening the port with a real `network` parameter* as the real fix, so whoever hits it is
  pointed at the right change rather than at loosening the check. `integrationId` is our OWN stored
  remote id for a post we published, so a value matching neither shape means a new network or corrupt
  data — never something to guess at.

**Test fixture corrected** — `direct.test.ts` used `"yt-video-1"` as a YouTube video id (3
occurrences). No real YouTube id looks like that; they are exactly 11 characters. A fixture that could
not exist is part of why the fallback read as safe, so it is now `"dQw4w9WgXcQ"`.

**Not changed** — the port's signature. Widening it is the architect's call and remains the clean
long-term answer (`direct.ts#listComments`'s own header says so); refusing is what makes deferring
that safe rather than merely cheap.

**Tests** — `direct.test.ts` 46/0/0 (+3: an Instagram-shaped numeric id, a foreign URN, and one
asserting the refusal message actually names the missing `network` parameter). `inbox-sync-job.test.ts`
8/0/0 unchanged.

### social-media `0.5.23` — 2026-08-23 — OAuth state is single-use; SMM-22's metered gap hardened

*(This entry was missing: the seat that did the work updated `MODULES.md` but not this file, and its
report listed CHANGELOG.md as updated. Reconstructed from its `MODULES.md` entry and its report.)*

**Fixed (security) — LinkedIn/YouTube `direct`-driver OAuth `state` is now DB-backed and atomically
single-use.** Both files' headers had named the signed-but-replayable state as a deliberate,
follow-up-flagged simplification. New table `social_oauth_states`
(`migrations/202608221751_social_oauth_states.sql`, third RLS wall, same predicate as
`social_oauth_tokens`) plus a shared `publisher/oauth-state.ts` (mint/parse/consume, mirroring
`core/google-oauth/state.ts`'s proven pattern) replace the two per-network signed-only
implementations. **RED**, captured before the fix via a stashed round-trip: the same signed state
verified successfully on a 2nd and 3rd presentation. **GREEN** (`oauth-state.test.ts` 10/10): a
second consume is refused with a typed `SocialOAuthStateError("unknown_expired_or_consumed")` — never
a silent second success, never a generic 500 — and two concurrent consumes of one token resolve to
exactly one winner via an atomic `UPDATE ... WHERE consumed_at IS NULL`, a database-enforced property
rather than check-then-act. Network-mismatch and cross-tenant cases covered too.

**Fixed (found in the same pass, independent of the above)** — `YouTubeOAuthStateError` was never
registered in `main.ts`'s filter list, so a malformed, forged or expired YouTube callback state
escaped as a **body-less 500**. That is the bug class `platform-nest/CLAUDE.md` records as having
recurred four times. Consolidating both networks' state errors into one `SocialOAuthStateError`
closes it by construction rather than by adding a fifth one-off filter.

**Hardened, NOT a live hole — stated plainly** — SMM-22's Cerbos gap for an agent/automation-origin
metered re-drive. Live probes against a standalone Cerbos serving the **unmodified** policy showed
`social.publishPostMetered` was **already denied** for both an n8n-origin and an agent-origin caller
(`isUnattended`), each presenting a plausible `approvalId`: the tool is simply absent from
`resource_mcp_tool.yaml`'s executable-tool bracket, and D14-13's grant-lift disjunct cannot fire
without a bracket entry. What was missing was documentation and a regression test, so that is what
landed — five live-Cerbos tests in `mcp-hub/src/cerbos.test.ts` using the real tool name, pinning the
denial for both caller shapes with and without a grant, and that a verified human is unaffected. The
policy edit is comment-only; `cerbos compile` verified clean before and after, with no `//` inside a
folded scalar (the mistake in this same file that broke every policy on `main` this week).

**Named, not silently decided** — `created_by` is stored on the new table for audit but is **not**
compared against the calling principal at consume time, unlike `core/google-oauth/state.ts`'s
login-CSRF defence. Tracked as its own follow-up.

**Measured** — platform-nest social suite 531 passed / 0 failed / 5 skipped (36 files) at the time;
`mcp-hub` 273/273, independently re-verified. `test:iam-chain-alignment` 25/25.


### reports `0.3.2` — 2026-08-23 — a foreign producer's series and tables are no longer dropped

**Fixed**
- `GrainCharts.tsx` keyed every section to a name `document-builder.ts` (TR-13) emits, which was
  correct while the four PM grains were the only producers of a `ReportDocument`. They are not any
  more: the social-media module builds its own (`social/reports.ts`) with keys no allowlist mentions
  — `impressions_daily`, `followers_daily`, `top_posts`, `kpi_vs_target`. A social report rendered
  through this kit, **including into a PDF via `/print/reports/[jobToken]`**, carried its KPI wall
  and its narrative but silently lost every series and table it had computed, and the reader had no
  way to tell an omitted chart from a metric that was never gathered.
- This is the failure the file's own governing rule already forbids, reached from the other
  direction: the rule is *"render what the document ACTUALLY CONTAINS and degrade honestly for what
  it doesn't"*, and a fixed allowlist stops doing that the moment a new producer appears. So rather
  than adding social's four keys — which breaks again for the next module — anything the
  grain-specific composition did not consume is now rendered generically, for all four grains.

**Two deliberate exclusions**, both to avoid rendering something WRONG rather than something missing:
- **Ratio series** (carrying `numeratorKey`/`denominatorKey`) are never charted by the generic pass.
  Per the file's own correctness note, a ratio charted alone silently sums per-bucket percentages —
  the average-of-averages bug. Which chart honestly represents a ratio is a per-grain judgement (for
  `on_time_rate` the answer was grouped bars over the two raw counters), so it stays with the grain
  composition. Skipping is honest degradation; a wrong frame is not.
- **Series with no points** are skipped, for the header's original reason: an empty chart frame
  implies the missing data is zero.

**Tests** — `GrainCharts.test.tsx` 12/0/0 (+4): a social-shaped document renders all four of its
sections; an already-consumed key is not double-rendered under its own label; an empty series is
skipped; a ratio series is refused. Proven red-then-green — removing the four wirings turns the
foreign-producer test red. `tsc --noEmit` clean.

### social-media `0.5.22` — 2026-08-23 — the metrics pull is gated where every other job is

**Changed**
- `metrics-job.ts` read `SOCIAL_METRICS_PULL_ENABLED` / `SOCIAL_METRICS_PULL_INTERVAL_MS` straight
  from `process.env` through two exported helpers. It was the **only** job in this module not gated
  by `config.social.*` — `inboxPull`, `inboxRetention`, `triage`, `slaGuard` and `reconcileEnabled`
  are all read from `config.ts` by `main.ts`. The gate now lives in `config.social.metricsPull`
  (`enabled` / `intervalMs`) and the two helpers are gone. The original deviation was explicitly
  temporary — `config.ts` was held by SMM-38a's parallel worktree at the time, and that file's own
  comment called the fold-in "a mechanical rename, not a redesign". This is that rename.

**Tests** — the two suite cases that mutated `process.env` and re-read the helpers were **removed,
not ported**. `config.ts` is evaluated ONCE at import, so a late env change is invisible to it by
design, and `main.ts` reads the flag once at startup. A test that set an env var and expected the
value to follow would have asserted a behaviour the real boot path does not have — worse than not
testing it. Replaced with three assertions against the config surface itself: dark-by-default (the
pull spends gateway calls per account, so defaulting ON would be a real cost, not noise), the 24h
interval default, and that the flag is a real boolean — guarding the `=== "1" || === "true"` form,
since a bare `Boolean(process.env.X)` reads the *string* `"false"` as ON, which is how a
dark-by-default job quietly starts running in an environment that tried to disable it.
`metrics-job.test.ts` 14/0/0. typecheck clean.

### social-media `0.5.21` — 2026-08-23 — a sustained inbox spike is announced once, not every tick

**Fixed**
- Spike detection had **no persistent dedup**, so a spike that lasted re-fired on every sweep tick
  and one burst became a stream of identical bells. `runTenantSpikeDetection` now suppresses a
  re-announcement inside a cooldown.
- **The dedup state is the `outbox_events` log itself**, not a new table. Every emit is already
  durably recorded there and `idx_outbox_events_entity
  (tenant_id, entity_type, entity_id)` already indexes exactly the lookup needed. A purpose-built
  dedup table would be a second store of "did we already say this" that has to be kept in agreement
  with the log that actually decides what was emitted. `outbox_events` is a CORE table, so the
  surrounding `declareSocialModuleScope` is inert for it and the tenant wall alone applies.
- **Correction to this entry's original wording** (2026-08-23, same pass): it claimed `outbox_events`
  "is never pruned". That is not true — `sync-engine-go/internal/gc/tombstone.go#purgeTombstones`
  deletes from it. The dedup is nonetheless sound, for a narrower reason: that GC's predicate is
  `(payload->>'_deleted') = 'true'`, so it only ever removes tombstones, and a spike payload has no
  `_deleted` key (`NULL = 'true'` → NULL → never matched). Recorded as a **latent coupling** in the
  code: if that GC is ever widened to prune by age or relayed status, this dedup silently weakens —
  a pruned announcement reads as "never announced" and the spike re-fires.

**Honest counting** — a suppressed spike is counted as `suppressed`, and `spikes` still counts what
is genuinely elevated right now. Collapsing them would make a sustained spike look like it had
*stopped*; a caller must be able to tell "quiet because nothing is elevated" from "quiet because we
already said so". Propagated through `runInboxSlaGuard` as `spikeSuppressed` so it is observable at
the job level rather than lost in the per-tenant return.

**Cooldown is DERIVED, not a new constant** — `SOCIAL_INBOX_SPIKE_RENOTIFY_MINUTES` defaults to `0`,
meaning `spikeWindowMinutes * (spikeBaselineWindows + 1)`: the point at which the spiking traffic has
fully aged out of its own baseline comparison, so a still-firing detector is reporting genuinely new
elevation rather than the same burst. Derived precisely so it cannot read as a measured or claimed
business number, matching this module's existing convention for these thresholds. It is computed from
the RUN's effective window/baseline, so an operator who widens the window widens the cooldown and
cannot accidentally re-notify inside a single baseline period. Not added to `.env.example` or the
compose `environment:` block — none of its four sibling `SOCIAL_INBOX_SPIKE_*` vars are there either,
and introducing the inconsistency for a derive-by-default knob would be worse than the omission.

**Tests** — `inbox-triage-job.test.ts` 15/0/0 (+2). Proven red-then-green: disabling the dedup check
turns both new tests red (`expected 1 to be +0`, `expected 0 to be greater than 0`).

### social-media `0.5.20` — 2026-08-23 — the report narrative can no longer state an invented number

**Fixed**
- The AI report narrative was the one AI output in this module with **no runtime guard**. The prompt
  told the model never to state a number it was not given; nothing checked that it obeyed, so an
  invented figure passed `parseReportNarrativeDraft` (which validated JSON shape only) and landed in
  a client-facing report. `findUngroundedNumbers` now traces every digit-run in the prose back to a
  grounding fact, and a draft that states an untraceable number is **rejected** in favour of the
  deterministic fallback — which states only the given numbers, verbatim.
- The prior reasoning for having no guard was that nothing can *strip* a hallucinated number out of
  free-form prose. That is still true, and is not the same claim: prose cannot be repaired, but it
  can be **declined**. Enforced at the single choke point every narrative passes through, the same
  "the platform owns the limit, the model's output is advisory" discipline `applyHashtagStrategy`
  already applies to hashtag counts.

**Deliberate trade-offs, recorded rather than smoothed over**
- The guard is **strict and will produce false positives** — "the top 6 posts" states a digit no KPI
  accounts for and is rejected even though it is not wrong. Accepted knowingly: a false positive
  costs a dull-but-true narrative, a false negative puts a fabricated figure in front of a client.
  `rejectedNumbers` is reported, not swallowed, so the real rate is observable and any future
  loosening is an evidence-based decision.
- Thousands separators are normalised first (a KPI of `12480` rendered `12,480` must not read as the
  two inventions `1` and `480` — the most likely false positive of all), and a decimal KPI grounds
  both its truncated and rounded renderings (`3.7%` → `3` or `4`), because a model reporting `4%` for
  a 3.7% rate is restating a given fact.
- A side effect of that decimal allowance: an incidental small integer can pass when it happens to
  equal the truncation of a decimal KPI, so "the top 3 posts" is accepted while "the top 6 posts" is
  not. Found by writing the strictness test, asserted explicitly in `ai-drafts.test.ts` so it is not
  rediscovered later as a phantom bug.
- A **rejected** draft and a **gateway hiccup** both surface as `draftedVia: 'fallback'`; only the
  rejection carries `rejectedNumbers`, and the controller records it on the activity row so the two
  are distinguishable. Deliberately **absent** rather than `[]` when nothing was rejected — an empty
  array would read identically on the checked-and-clean and the never-checked paths, which is the
  absent-vs-zero conflation this module refuses everywhere else.

**Not changed** — the wire contract. `narrativeSource` stays `'ai' | 'deterministic'` and
`draftedVia` stays `'ai' | 'fallback'`; `lib/reports.ts` in `platform-ui` is canonical for the
`ReportDocument` shape, so widening either would be a UI + FRONTEND-BFF-CONTRACT change and is not
needed to close the hole.

**Tests** — `ai-drafts.test.ts` 41/0/0 (+12), pure unit, no DB. `social-reports.test.ts` and
`social-ai-drafts.test.ts` 15/0/0 unchanged and green, confirming no existing report fixture was
relying on an ungrounded narrative passing.

### social-media `0.5.19` — 2026-08-23 — a retracted client ask is now told to the client

**Fixed**
- `social.client_review.withdrawn` had **no registered event handler**, unlike `.requested` and
  `.decided`. The event was emitted, relayed to the (already-drained) `events:social_post_variant`
  stream, and read by nobody. `.requested` had put *"a post is ready for your review"* in the
  client's bell aimed at `/portal/social-reviews`; withdrawing left that entry live, pointing at a
  row the client could no longer see — a vanished item reads as a broken portal, not as a withdrawn
  request. That is the same "absent is not zero" conflation this module refuses everywhere else.
  `handleClientReviewWithdrawn` (`event-handlers.ts`) now notifies the CLIENT that the ask was
  retracted, reaching the same audience and the same `kind: 'general'` as `.requested`.

**Changed**
- `social.controller.ts#withdrawClientReview` now enriches the `withdrawn` payload with
  `clientId`/`projectId`/`postTitle` using the SAME third-walled join `requestClientReview` already
  uses — rather than the handler re-deriving it, which is how a second copy of that join drifts.
  When the variant was soft-deleted while its review sat pending the join returns no row and the
  client fields stay **absent**; this deliberately does NOT fall back to the review row's own
  `client_id`, because `resolveClientRecipients` scopes on `projectId` and a clientId recovered
  without a trustworthy projectId would notify a **wider** audience than the original ask reached.
- The `social.withdrawClientReview` MCP tool stays impact `'low'`. Its prior justification cited
  "never notifies the client", which is no longer true; the surviving ground is that the `'medium'`
  bar is *the first moment a variant becomes visible outside the tenant*, and a withdrawal notice
  carries no variant content and creates no new exposure. Comment corrected in place rather than
  left to read as current.

**Tests** — `event-handlers.test.ts` +2 (the notify path asserts the retraction WORDING, not merely
that a row landed; plus a no-recipient case pinning that absent client fields mean silent, never
broadcast). `client-review.test.ts` +1 registration pin, deliberately separate from the existing
non-exhaustive `arrayContaining` check — that check stayed green throughout the period the handler
was missing, which is exactly why it did not catch this. Proven red-then-green: deleting the
registration line turns the pin red with its own diagnostic. `src/modules/social` 538/0/0 measured
directly (35 files).

### search-marketing `0.5.2` — 2026-08-23 — SM-76: site-audit v2 schema + IAM wave

**Added (schema, migrations `202608221727`/`202608221728`)**
- `search_finding_states` — one row per (property, check_key, scope): the trackable finding entity
  making "which properties still have finding X" a single indexed SELECT and making triage STICKY
  across runs (design `docs/plans/2026-08-23-seo-audit-capability.md` §2.3).
- `search_audit_checks` — per-run check coverage (`passed`/`failed`/`error`/`not_run`/`unsupported`)
  so an empty findings list is distinguishable from "never checked" (the honesty spine, §7).
- `search_property_facts` — provenance-stamped property facts (CMS/hosting/attestation), append-only
  chain with a partial-unique "current fact" index.
- `search_audits` +`group_id`, +`kind='security'`, +`source='psi'` (CONKEY constraint-surgery
  idiom); `search_audit_findings` +`state_id` (nullable FK into `search_finding_states`).
- All 3 new tables carry `tenant_id`+`client_id NOT NULL` + FORCE RLS with the module's byte-identical
  third-wall predicate (`tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')`).

**Added (IAM)**
- 3 new catalog permissions: `search.finding.triage` (baseline), `search.finding.accept_risk`
  (**sensitive** — the concealing direction: accept-risk/false-positive), `search.property.attest`
  (**sensitive** — an accountability record that can flip a security check to passing on a later
  run). New Cerbos kind `resource_search_finding`; new `attest` action on the existing
  `resource_search_property` kind.
- Role bundles: `search_manager`/`company_admin`/`platform_admin`/`owner` hold all 3; `search_staff`
  holds `triage` only (not the two sensitive actions) — mirrors the kind's existing staff/manager
  split on every other `resource_search_*` kind.
- `permission-catalog.json` 298→301 (286 grantable, 78 kinds); `permission-groups.json` gained
  `search_accept_finding_risk` and `search_attest_property_facts` (sensitive groups) + `search.finding.
  triage` folded into `search_manage_drafts`.

**Verified**
- Live Cerbos, restarted + probed directly (`/api/check/resources`): staff gets `triage`, not
  `accept_risk`; manager/company_admin/platform_admin get both plus `attest`; cross-tenant, low-
  assurance, and unanchored/cross-root `group_executive` probes all DENY as designed; the IAM-04
  permission-arm mirror (flat `perms`, no role) grants exactly `triage`, denies `accept_risk`.
- RLS (`src/db/module-search-audit-v2-rls.test.ts`, real NOSUPERUSER role): right-tenant+scope
  visible, no-scope zero rows, cross-tenant zero rows, empty-set zero rows, WITH CHECK blocks a
  smuggled cross-tenant insert, the partial-unique current-fact index blocks two simultaneously-
  current rows for one key (and allows a proper supersede chain).
- `permission-catalog.db.test.ts` (12/12), `role-catalog-drift.db.test.ts` (5/5),
  `iam-215-boundary-pin.test.ts` (83/83), `test:iam-chain-alignment` (25/25) all green.

**Known gap, flagged not silent**
- A concurrent same-day migration in this shared checkout (`202608230230_iam15_remove_group_
  executive.sql`, D-7) retires the `group_executive` role estate-wide; its Cerbos-policy-file half
  (stripping the role from ~46 `resource_*.yaml` files) had not yet reached the search module's
  policies as of this change. This entry's 2 touched/added policy files still carry a
  `group_executive` rule (matching the design doc's own text and every sibling `resource_search_*`
  file as they stood at write time) and will need the same strip in IAM-15's follow-through.
- `role-permission-bundles.json` (the generated JSON mirror) was deliberately **not** regenerated:
  the live working tree has ~45 unrelated, uncommitted `cerbos/policies/*.yaml` edits in flight from
  that same concurrent IAM-15 effort, and regenerating now would check in a corrupted intermediate
  snapshot. Verified correct output locally (uncommitted) for this change's own keys.
- Status stays module-level `DEV-VERIFIED` for schema/RLS/Cerbos (this wave); the site-audit
  *capability* itself (checks, finding-state machine, orchestration, UI) remains `PLANNED` — SM-77
  onward.

### social-media `0.5.18` — 2026-08-23 — SMM-25: Playwright console suite (no product code, version unchanged)

**Added**
- `platform-ui/e2e/social-console.spec.ts` (13 tests) + a new `social` project in
  `playwright.config.ts` — the department's whole-merge-gate suite, over DEMO_MODE
  (`src/lib/demoSocial.ts`). Covers all four department routes (`calendar`/`composer`/`inbox`/
  `analytics`, `dept-4`) plus the client-review portal list+detail pages.
- One additive DEMO_MODE fixture: `soc-post-10`/`soc-var-11` (`demoSocial.ts`) — closes a real gap
  where NO seeded variant targeted `soc-acc-tiktok-1`, so the best-time chip's `'unsupported'` state
  (SMM-27's own seed) could never actually render in a browser.

**Scope, stated plainly**
- The addendum's original SMM-25 row asked for full-stack e2e + a Playwright suite + DEMO_MODE
  fixtures. Fixtures already existed; full-stack live e2e is undrivable by anyone today (every
  platform app credential in the estate is empty, app reviews deferred to staging, D-23). This entry
  is the DEMO_MODE Playwright suite only, never presented as live verification.

**No product defect found**
- Every first-pass test failure was a locator scoped too broadly across a page that legitimately
  renders one fact twice, or one cross-test race inside the new suite itself (fixed with
  `test.describe.configure({ mode: "serial" })`, not a blanket `.first()`). Re-run twice after
  fixing (8-worker parallel, 32.6s; 1-worker serial, 49.4s) — 13/13 both times.

Full detail: `docs/modules/MODULES.md`'s social-media `0.5.18` (SMM-25) entry,
`docs/plans/smm-tracker.md`'s SMM-25 evidence block.

### social-media `0.5.18` — 2026-08-23 — SMM-27: best-time-to-post — classical stats job + suggestion chip

**Added**
- `best-time.ts` (new) — a deterministic, non-AI computation over SMM-21's `social_post_variants` +
  `social_post_metrics`: buckets published, measured posts by UTC hour of `published_at`, engagement
  score = sum of available likes/comments/shares/saves/clicks, picks the highest-average bucket that
  clears `config.social.bestTime.minBucketPosts`. A post whose latest metrics snapshot is entirely
  NULL is excluded from the sample — never counted as zero engagement.
- `BestTimeStatus`: `not_yet_computed` / `insufficient_evidence` / `unsupported` / `suggested` — four
  distinct facts (never a boolean, never a fabricated hour). Thresholds
  (`minMeasuredPosts` default 5, `minBucketPosts` default 2) are `config.social.bestTime` with a
  documented rationale, never a hidden constant, and ride the API response so the chip can quote them.
- New migration `202608221603_social_best_time_suggestions.sql` — `social_best_time_suggestions`
  (one UPSERTED row per account), third RLS wall, `sbt_status_shape` CHECK enforcing the three
  persisted statuses structurally.
- `best-time-job.ts` (new) — the nightly sweep (`smm-best-time`), env-gated
  (`config.social.bestTime.enabled`), dark by default, `withGlobal`→per-tenant→per-account isolation,
  mirroring `metrics-job.ts`/`inbox-triage-job.ts`.
- `GET accounts/:accountId/best-time` + `POST accounts/:accountId/best-time/recompute` + MCP tool
  `social.getBestTimeToPost` (read, reuses the existing `social_account`/`read` gate).
- `VariantCard.tsx`'s new `BestTimeChip`, wired into the Composer per-variant-account; DEMO_MODE
  fixtures seed all three non-default states across three accounts.

**Module GUC (defect class #1) — closed and regression-pinned**
- `computeAccountBestTime`/`applyBestTimeSuggestion` self-declare `declareSocialModuleScope`;
  `best-time.test.ts`'s (G1) proves the RLS trap directly (an unscoped read sees zero rows on a table
  a seeded row plainly exists in), (G2) proves the real functions write/read back a correct
  `suggested` verdict with no `{modules}` option at any call site — the ticket's own named worst
  failure mode (a stats job silently computing over an empty set and still emitting a confident
  `insufficient_evidence`) is closed and pinned.

**The clock**
- UTC hour-of-day, always — no per-account timezone column exists in this schema to localize
  against, and this module already shipped a real local-midnight/`toISOString()` timezone bug at this
  exact seam (SMM-35). The chip renders "14:00 UTC" verbatim.

### social-media `0.5.17` — 2026-08-22 — SMM-35: assistant "social summary" read; no social write reachable from chat this pass

**Added**
- `assistant-summary.ts` (new file) + `GET engagements/:engagementId/assistant-summary` + MCP tool
  `social.getEngagementSummary` (read, `minAssurance:"low"`, Cerbos `read` on `social_engagement` —
  no new permission) — one engagement's post-status counts, open/escalated inbox counts, each
  connected+in-scope account's latest KNOWN follower reading, and metered-usage snapshot. Reuses
  `reports.ts`'s `sumKnown`/`latestKnown` and `usage-ledger.ts`'s `readUsageSnapshot` verbatim — no
  second copy of either discipline.
- Absent-vs-zero, proven not just stated: a connected account with no `social_metrics_daily` row
  ever reports `followers: null`/`everPulled: false`, never a fabricated `0`; a row whose `followers`
  reading is itself `NULL` still reports `null` but flips `everPulled: true` (pulled, that field
  wasn't); a genuine zero (no posts, no open threads) renders as a real `0` — these are OUR OWN rows,
  the one carve-out `reports.ts`'s own header already draws.
- Accounts/inbox are scoped to the engagement's OWN `tool_scope.networks`, mirroring
  `content-brief.ts`'s account-resolution rule — `social_accounts` belongs to the CLIENT, not the
  engagement, so two engagements sharing a client must not leak each other's accounts/metrics/inbox
  into one summary.
- Cross-client leak test (`assistant-summary.test.ts`): two engagements under different clients,
  each with its own post/thread/follower marker, driven back to back against the same running app —
  every count, account id, and follower reading in one engagement's summary is asserted absent from
  the other's.

**Found and named, not built (a real cross-repo gap, not improvised around)**
- No social WRITE (drafting or publish) is wired to a chat-invocable agent this pass. `social.
  publishPost`/`sendReply` are excluded deliberately: both are `impact:"high"`, already D14-registry
  executables for the automation/agent-origin suspend path, and exposing them to chat would be a
  second, weaker route to an irreversible public act — never built. `social.draftContentBrief`
  (SMM-26, `write:true,impact:"low"`) is excluded not by risk but by a genuine cross-repo dependency:
  the assistant broker (`platform-nest/src/modules/assistant/broker.ts`) can only drive a turn
  through an agent BOTH it and `ai-agents/src/specialists.ts` declare — the assistant's own binding
  policy (every write becomes a proposal, `task-filer`'s own header) means any new social agent must
  declare the tool `high_write` and pass D13's eval-provider enrollment (a live run against the
  shared, rate-limited Ollama Cloud quota) before it can execute past `forced_read_only`. That is
  `ai-agents/**` work, outside this ticket's file surface (never listed as "yours") and sized like
  the original ASST-23 design's own T2 ticket (`senior-be`). Recommended as a follow-up ticket, not
  improvised here.

Test counts: `src/modules/social` + the three `d14-smm-{09,17,22}-social-*-registry.test.ts` files —
**605 / 0 / 5** (baseline for this exact set, this session's own full run: 599; +6 new, all in the
new `assistant-summary.test.ts`, also re-run ALONE — 6/6 green). `tsc --noEmit` clean on this
session's own touched files. No migration, no Cerbos change, `src/modules/assistant/**` untouched.
Full detail: `docs/plans/smm-tracker.md`'s SMM-35 evidence block.

### social-media `0.5.16` — 2026-08-22 — SMM-26: MCP agent surface audited + `smm-agent-content-brief`

**Audited (no code change needed — the invariant already held)**
- All 34 declared `social.*` MCP tools, walked one by one, for what an `assurance:"low"`
  automation/agent principal actually gets from `mcp-hub/src/policy.ts#authorize`'s impact gate.
  12 reads execute unattended; 15 `write:true,impact:"low"` tools (draft rows / knowledge pointers /
  mirrored registry state only) run unattended by design; 4 `impact:"medium"` writes
  (`setEngagementScope`, `requestClientReview`, `provisionPublisherOrg`, `deliverReport`) correctly
  suspend into WS4; the 3 real publish/send tools (`social.publishPost`/`social.publishPostMetered`/
  `social.sendReply`) are the pinned `write:true,impact:"high"` classification and always suspend.
  Full per-tool table: `docs/plans/smm-tracker.md`'s SMM-26 evidence block.

**Added**
- `content-brief.ts` (new file) — the `smm-agent-content-brief` flow: one call drafts N idea posts
  (`source='agent'`, count defaults to the engagement's own `tool_scope.posting.cadencePerWeek`) and
  one caption-drafted variant per connected+enabled-network account. Reuses SMM-19's own
  `ai-drafts.ts`/`gateway-client.ts`/`knowledge-client.ts` path — no second AI/knowledge route.
- `POST engagements/:engagementId/agent-content-brief` + MCP tool `social.draftContentBrief`
  (`write:true,impact:"low"`) — every write is a draft row; can never dispatch, publish or send.
- `config.social.contentBrief.maxVariantsPerCall` (default 20) — a self-imposed cap on one call's
  own (idea × account) gateway-call volume, never a claimed vendor limit.

**Found and named, not fixed (a follow-up, not improvised)**
- The v1.0 design's "weekly per opted-in engagement" scheduled sweep for this flow was NOT built:
  a principal-less scheduled job cannot legitimately call WS8's per-principal-scoped `/search`
  (the tenant pre-filter needs a resolvable caller identity) without either leaving drafts
  permanently ungrounded or borrowing a human's identity dishonestly. Needs an architect decision on
  an automation service identity for RAG-grounded scheduled jobs generally.

Test counts: `src/modules/social` + the three `d14-smm-{09,17,22}-social-*-registry.test.ts` files —
**599 / 0 / 5** (baseline for this exact set, measured directly by stashing: 591; +8 new, all in the
new `content-brief.test.ts`). Full detail: `docs/plans/smm-tracker.md`'s SMM-26 evidence block,
`docs/modules/MODULES.md`'s social-media `0.5.16` entry.

### social-media `0.5.15` — 2026-08-22 — SMM-22: X metering live — the money path

**Added**
- `POST variants/:variantId/publish-metered` — the metered twin's own dispatch endpoint, backed by
  the SAME `dispatch.ts#dispatchApprovedPublish` as the free tool. `social.publishPostMetered` gets
  its first real `McpToolDef`.
- `GET engagements/:engagementId/usage` (`social.ledger.read`) — month-to-date spend vs all three
  D-9 stop-loss tiers (engagement/tenant/global). New `UsagePanel.tsx` on the Analytics tab.
- `usage-ledger.ts` (new file): the D-9 three-tier `evaluateUsageBudget` arithmetic, the ledger
  read/write surface, and `reserveUsageSpend` — a per-engagement advisory-lock reservation that
  closes the TOCTOU race between two concurrent metered dispatches.
- `config.social.usage.*` — X's per-post price (`SOCIAL_X_PER_POST_COST_USD`/
  `SOCIAL_X_PER_POST_WITH_LINK_COST_USD`, no default), the tenant cap (optional) and global cap
  (documented $100/mo default, design §05), and `SOCIAL_METERED_PUBLISH_ENABLED` — the explicit,
  boot-guarded gate that lifts `social.publishPostMetered`'s bar.
- `liftBarredExecutable` (`approval-executables.ts`) — the one deliberate primitive that may lift a
  D14 bar, called from exactly one config-gated site that refuses to boot if X's price is
  unconfigured.
- Two new refusal tokens: `metered_price_unconfigured` (budget stage) and
  `metered_tool_requires_metered_network` (scope stage, the symmetric check to SMM-09's own
  `metered_network_requires_metered_tool`).
- `estimatedCostUsd`/`costUnavailableReason` on `GET .../publish-preconditions` and
  `GET .../variants/:id/validation` — the approval card's own live price, `null` (never `$0`) when
  X pricing is unconfigured.

**Changed**
- `media-rules.ts#estimateCostUsd`'s contract: `number` → `{ok:true,costUsd}|{ok:false,reason}`,
  fed by config instead of a hardcoded literal. Every write path on `social.controller.ts` that
  persists `estimated_cost_usd` now refuses the whole write rather than storing a fabricated `$0`.
- `dispatch.ts#dispatchApprovedPublish` takes an optional `toolName` param — one implementation now
  serves both `social.publishPost` and `social.publishPostMetered`.
- `post-status-sync-job.ts#applyPostStatuses` trues up a metered variant's ledger reservation
  (`posted → completed/failed`) in the SAME transaction as its authoritative status flip.

**Found and fixed while building**
- The first version of the precondition's tenant/global-tier check applied to EVERY publish,
  including $0 ones — one tenant's X overspend would have frozen every other tenant's free posting
  platform-wide. Fixed to gate the new tiers on an actually-metered network only; the pre-existing
  engagement-tier circuit breaker (SMM-09) is unchanged.
- `publish-gate.test.ts` pinned "the metered twin never appears on the module contract" — no longer
  true once this ticket built its real endpoint. Updated to assert the twin IS declared but stays
  barred from D14 auto-execution by default.

**Not done this pass (named, not hidden)**
- The usage panel is unit/type-checked only — not driven in a real browser.
- `cerbos/policies/resource_mcp_tool.yaml` was not updated for an agent/automation-origin re-drive
  of an unbarred metered publish (a human's own manual `publish-metered` call needs no Cerbos
  change; only the automation/agent re-drive path does).
- X's real billing trigger (charged on request-acceptance vs. confirmed-publish) is unverified
  against a live account (D-23) — the ledger's reserve/true-up lifecycle is the best-supported
  reading of design §05, not a verified vendor fact.

Test counts: `src/modules/social` + the three `d14-smm-{09,17,22}-social-*-registry.test.ts` files —
**591 / 0 / 5** (baseline for this exact set, measured directly: 552; +39 new). `platform-ui`:
**2592 / 0 / 0**. Full detail: `docs/plans/smm-tracker.md`'s SMM-22 evidence block,
`docs/modules/MODULES.md`'s social-media `0.5.15` entry.

### platform-nest `0.34.0` — 2026-08-21 — MSO-05: the observability console learns there is more than one server

`GET /api/admin/observability` (Plane A, staff-only) grows from a single-box summary into an
estate view — `docs/plans/2026-08-21-multi-server-observability.md`, contract
`docs/FRONTEND-BFF-CONTRACT.md` §20.1a (PENDING → 🟡 PROTOTYPED, backend only).

**Added**
- `hosts[]` + `estate` + Alertmanager-sourced `alerts[]`, alongside §20.1's legacy
  `host`/`targets`/`datastores` fields for one release (expand/contract — a deployed UI still
  reads the old shape). New pure module `src/admin/estate-observability.ts` carries the freshness
  state machine (`fresh`/`stale`/`dark`/`never`, the `dark` boundary shared byte-for-byte with the
  600s `RemoteWriteStalled` threshold) and every null-vs-zero mapping function, split out
  specifically so it is unit-testable without a live Prometheus, Alertmanager, or database.
- `infra_hosts` (migration `202608211610_mso04_infra_hosts.sql`) — built under THIS ticket because
  MSO-04 had not landed and MSO-05 cannot show an expected-but-dark host without an inventory table
  that survives the host going silent. Global (non-tenant) table, no RLS, `withGlobal()`-only —
  same posture as `permissions`/`roles`. Seeded with the two hosts verified live (`gda-aicenter`
  production/erp-core, `sumopod` ops/observability-hub).
- `ALERTMANAGER_URL` config (`config.observability.alertmanagerUrl`). Alerts now come from
  Alertmanager v2, not Prometheus's `ALERTS` series, so silence/inhibition state is visible —
  fetched INDEPENDENTLY of Prometheus's own reachability, so a Prometheus outage doesn't also blind
  the console to currently-firing alerts.
- `containersRunning` is now a hardcoded `{value: null, note: "...MON-09n..."}` reading for every
  host — cAdvisor's per-container discovery is verified broken estate-wide, so this is never
  queried and never allowed to read as a measured `0`.

**Found and fixed while building**
- The ratified §20.1a design text names a NEW `alerts: EstateAlert[]` field and then says the
  expand phase also carries forward "§20.1's legacy ... alerts field" — two fields cannot share one
  JSON key. Resolved by keeping the one Alertmanager-sourced `alerts` field (a structural superset
  of the old shape for any reader touching only `name`/`severity`); recorded as contract note 8
  rather than silently picked.
- `mergeHostInventory`'s "unregistered host" detection originally unioned only the freshness map
  with `infra_hosts` rows; a host present in `up`/target/datastore series but (for any reason) not
  in the same round's freshness result would have been silently dropped instead of rendered
  unregistered. Widened to union every host-keyed metric map — caught by the live-DB test, not the
  pure unit tests, which is exactly why both exist.

**Tests**: `estate-observability.test.ts` 31/31 (pure — freshness boundaries incl. clock-skew, the
three null/zero/error outcomes never collapsing, target/datastore null-vs-measured-empty,
Alertmanager mapping, and the inventory merge's unregistered/never/decommissioned-aging-out cases).
`observability-estate.db.test.ts` 8/8 against real Postgres + Cerbos + stubbed Prometheus/
Alertmanager (`app.inject`): 403 for non-admin, full estate assembly, containersRunning
null-with-note across every host, measured-vs-not-shipped datastores, Alertmanager
active/suppressed split, legacy-field derivation, and the two upstreams' independent-failure paths.
Full `src/admin/` suite (33 files) green at 421/421 with both new files included. Three
platform-nest lints (`lint:withtenants`, `lint:migration-rls`, `lint:migration-names`) all pass —
no `withTenants()` call was introduced (this table is read via `withGlobal()` only) and no
FORCE-RLS backfill risk exists (the table carries no RLS at all).

**Not done in this ticket** (explicitly out of scope, named so nobody assumes otherwise): MSO-02
(env-routed Alertmanager paging + the `by (host)` generalization of the `DiskSpaceLow`/
`RemoteWriteStalled` alert rules — the by-host queries this ticket ships are ahead of the still-
single-host live rules), MSO-06 (console UI consumption — a concurrent session owns
`platform-ui`), MSO-07 (QA adversarial pass), MSO-08 (onboarding the rest of the fleet). No live
server was touched; verification was against a stubbed Prometheus/Alertmanager and a disposable
test database only.

### platform-ui `0.40.0` — 2026-08-23 — the whole surface, redesigned

A five-phase overhaul of the entire ERP surface, not an increment. The version jumps deliberately:
every route in the app looks different, and the design system underneath it was replaced rather
than extended.

**Changed — the token layer (Phase 1)**
- Dark is now the primary designed theme; light is derived. A 12-step warm neutral ramp
  (`--n-1..12`) replaces ad-hoc surface hexes. `--n-2` is byte-identical to the shipped page
  background — this systematises the existing identity rather than departing from it.
- **Interactive split from decorative.** `--accent` previously meant the wordmark, every button,
  the focus ring AND the "in progress" badge at once, so nobody could make buttons louder without
  repainting what "in progress" means. Bronze is now decorative-only; a teal carries every click
  target. A guard assertion makes the split permanent.
- Elevation is luminance-led on dark and shadow-led on light — shadows are nearly invisible on a
  dark surface, which is the usual mistake.
- Radius scale, 4pt grid, and three real density modes at token level. The old `data-density`
  flipped five hand-written selectors and never touched table rows, the one place density matters.
- PM's 8-tone ramp promoted to `--cat-1..8` app-wide, plus an `-area` tier: chroma validated for
  chips reads as crayon at chart scale.
- `tokens/pm.css` reduced to pure `var()` aliases — zero colour literals, the mechanical proof the
  Material island is gone.

**Fixed — contrast, measured rather than assumed**
- The spec predicted amber would fail the 3:1 non-text floor. Five hues already passed. The real
  failures were `status-idle` at **2.50:1** and `status-neutral` at **1.90:1** (plus dark neutral at
  2.16:1) — none of which anyone had flagged. Now 3.92 / 3.32 / 3.30:1.
- Four PM controls painted `background: var(--pm-accent)` with `color: var(--pm-accent-fg)`, and
  those tokens resolve to the same value in both themes: **text exactly the colour of its own
  background**. Audited the whole tree afterwards; no other surface had it.
- Urgency chips mixed their tint against `transparent`, so the effective colour drifted with
  whatever surface the chip sat on — 3.90:1 on the light page. Now mixed against a fixed token.
- Department rail headings used `opacity: 0.6` instead of a token, double-compositing alpha below
  the AA floor.
- `--ink-faint`, exempt from AA because it is for decorative glyphs only, was carrying real
  readable content in the portal.
- The Social Media queue filter was `role="tablist"`/`role="tab"` with **no `tabpanel`** — a real
  WAI-ARIA violation, now a toggle-button group.
- The portal header overlapped its own status text at 390px. It triggered no page scroll, which is
  why an automated width check missed it; found by opening the screenshot.

**Added — shell and scope (Phase 2)**
- **ScopeBar**: Entity / Department / Period / Currency as real controls, with an explicit
  "Whole group" option. Consolidated had been an implied default with no control at all. State
  lives in the URL, so a scoped view is linkable.
- **CompanySpine**: a tone-coded strip between nav and content making "which entity am I in, and
  what else exists" a permanent ambient fact rather than a dropdown you must open to remember.
- **Command palette** (Cmd/Ctrl-K), hand-rolled, RBAC-filtered, wired to the existing search reader.

**Added — data surfaces (Phase 4)**
- DataTable extended (sticky header, column control, sortable, numeric alignment, density-aware,
  distinct error state), plus FilterBar, Pagination, BulkActionBar, Tabs, Menu, Drawer, Modal and a
  ToastQueue — eight primitives replacing per-surface reimplementations. `/clients` is the
  reference wiring.

**Closed**
- The guard's radius exception list shrank to `[]`. `creative`, `pipeline` and `portal` no longer
  ship literal `border-radius`; the "zero radius" law had never actually been enforced outside
  `globals.css`.

**Constraint held throughout**: still exactly four runtime dependencies. Every primitive, overlay,
chart and the command palette is hand-rolled.

**Verified** — typecheck clean; token guard 22/22 with no assertion weakened; **169 files / 2705
tests** green; `DEMO_MODE=1 next build` green; Playwright chromium 49/53, pm-unified 10/10
unmodified, portal 8/8, social 14/14, smoke 1/1. Zero horizontal page scroll at 390px. The three
remaining chromium failures were each re-run in isolation, fail identically there, and are
pre-existing outside this work — left failing and reported rather than papered over.

**Test-infra note for whoever runs these next**: Playwright projects share one `.next` directory,
so they must run one at a time AND with `--workers=1`. `fullyParallel: true` plus a stateful
in-process demo store makes parallel workers invent failures — 8/10 phantom failures on
`pm-unified` that are all green serially.

### platform-ui `0.29.1` — 2026-08-21 — the company report said its own name twice

**Fixed**
- **The duplicate was the SIDEBAR.** `0.29.0` removed the in-page H1/H2 pair; this removes the one
  left behind — the sidebar pins the active company under a COMPANY label while the page title
  printed `scopeName`, so the company name appeared twice on one screen. Title now states what the
  page is. Project/department keep `scopeName` deliberately: those names are NOT in the sidebar.
- **The demoted tail was still fourteen cards.** Bordered boxes read as fourteen competing objects,
  and 14 into a 6-column track stranded two on a ragged last row — the border is what made the
  raggedness visible (an empty cell is invisible, an absent box is a hole). Now a borderless stat
  grid: tail 662px -> 118px, whole KPI block ~600px -> 234px on the live values.
- **The cascade bug that hid both**: the compact rules were a single `.rc-kpi--compact` class
  declared ABOVE the base `.rc-kpi` that carries `border` and `padding: 16px`. Equal specificity,
  later declaration wins, so the band kept its boxes while the font sizes appeared to apply. Scoped
  through the parent band now, order-independent.

**Verified** — 20/20 overflow checks at 698/858/1116px, tsc clean, 2484/2484 tests, plus a
dark-theme render of the real live values reviewed at each step (which is what caught the cascade
bug, and rejected a full-width two-column row layout that measured WORSE than the grid).

### platform-ui `0.29.0` — 2026-08-21 — six pages that answer at a glance

`/`, the four `/reports/*` grain pages and `/admin/users`. Diagnosed by driving the LIVE box, which
changed the diagnosis twice and then caught a regression this same work had shipped one release
earlier — the numbers below are measurements, not estimates.

**Changed**
- **Two headers became one.** `PageHeader` + `ReportViewer`'s own 24px scope heading meant
  `/reports/company` printed the company name twice in a row at two sizes. The viewer's heading is
  now a `scopeHeading` prop DEFAULTING TO TRUE, because `app/print/reports/[jobToken]` mounts the
  viewer with no `PageHeader` and `print.css` styles `.rc-header__scope` as the PDF title —
  suppressing it outright would have shipped a titleless export.
- **KPI weighting.** Seventeen kpis in one flat grid at identical weight, twelve reading `0`/`0%`/`0m`
  on a live account. Now a lead band of four over a demoted compact tail; nothing hidden, and the
  `ChartDataFallback` table still lists all of them. Lead uses EXPLICIT 4/2 column counts, not
  auto-fit: `minmax(200px, 1fr)` resolved to three columns in the ~698px main column and laid four
  tiles out 3-then-1, which the first version of this change shipped.
- **The noise inside the tiles**, which the first pass left untouched and which is why the page still
  read as a wall: `"vs 1 Jul - 31 Jul"` rendered on all eighteen tiles while the header states the
  compared range once, and `NOT APPRAISED` rendered eleven times. The range no longer reaches a tile
  (the delta FIGURE is the per-tile fact and stays); the appraisal marker is an inline degree sign
  explained ONCE by a legend under the bands. §5.2's disclosure is preserved and now reads as a
  sentence rather than jargon repeated eleven times.
- **`/admin/users`**: the per-row role form (~200px per person) moved behind a native `<details>`;
  name+email merged into one identity cell so the `service` badge stops colliding across the column
  gap; humans sort before service accounts, which on the live company had put four automation
  accounts above every colleague.
- **Project/department pickers**: three bordered tiles became one inline stat strip.
  `minmax(100px, 1fr)` needed 320px in a ~318px card, so it wrapped 2-then-1 with a dead cell.
- **Home**: the check-in card's two prefilled textareas inherited a global 72px `min-height` and
  pushed "Needs you" below the fold; scoped to 46px, still resizable, global rule untouched. TR-10's
  four render branches and <=3-interaction budget deliberately left alone.

**Fixed**
- **The assistant FAB was covering CONTROLS** — Approve/Deny on Home, the last row of the users
  table. It is `position: fixed` and reserved no space. The selector hangs off `.erp-app`, not
  `.erp-main`: the FAB is a SIBLING of `.erp-main`, so `.erp-main:has(.asst-fab)` matches nothing.
- `.rc-kpi__label-row` overflow (181>171 on six of seventeen tiles) — the appraisal badge was a
  second flex child in that row. The replacement mark sits INSIDE the label span for exactly this
  reason: inline in the text it wraps with the words and cannot overflow the row.
- **...and the regression that fix caused** (`.rc-kpi__foot` 142>138, x4 per report), found only by
  re-shooting the live pages after release. The verification harness had asserted on the row being
  FIXED and never on the row things were moved INTO; it now measures every descendant of every tile.
- `.dept-table-scroll` lifted to `ui.css` as `.lux-table-scroll` — it guards `.lux-table`, a ui.css
  primitive used outside the department console, and `/admin/users` needed it.

**Verified** — 20/20 checks against the real stylesheets at the three actual main-column widths
(698/858/1116px), zero overflowing elements anywhere in a tile; `tsc` clean; 2483/2483 tests.
`Productivity.test.tsx` retargeted at the new disclosure and strengthened to require the legend and
its wording (the PM productivity surface composes the same `KpiTiles`; an earlier grep for that
contract was scoped to `components/reports` and missed it).

### monitoring `0.2.0` — 2026-08-19 — the IAM catalog was only half-seeded

**Fixed**
- **Five Cerbos actions had a policy rule and no catalog row**: `monitor_incident::read`,
  `monitor_maintenance::read`, `monitor_maintenance::delete`, `status_page::read`,
  `status_page::update`. Two of them — the incident list and the detail route's maintenance lookup —
  are authorized by code that is **already in production**, so the running platform was deciding
  against pairs the catalog did not describe. Added to `permission-catalog.json`, to the DB, and to
  the module contract (9 → 14 declared permissions).
- **`manager` and `group_executive` held zero monitoring bundle rows** while every monitoring policy
  names them, so Cerbos allowed a plain manager all 14 actions with the DB mirror recording none.
  Found by `role-permission-parity.db.test.ts`; 19 rows added (manager 14, group_executive 5 reads).
- **The `permissions` table had drifted 9 rows ahead of the catalog** (293/284, sensitive 105/102),
  breaking the row-count invariant `0093` establishes. Restored to 298/298 and 106/106.
- **Heartbeat ingest could never have worked** (`0119`): being unauthenticated by design it has no
  tenant context, so FORCE RLS filtered every row and the endpoint returned 200 having matched
  nothing. Now a `SECURITY DEFINER` function with a pinned `search_path`, matching on the token
  hash's unique index.

**Added**
- Seven `monitoring_*` permission groups, giving all 14 keys an authoring path; each action that is
  destructive, reaches outside the ERP, or conceals an outage is its own withholdable group.
- `monitoring_staff`/`monitoring_manager` registered in the role-bundle generator, the parity
  suite's independent resolver, and the role-catalog drift baseline — three places that each
  silently skip a role they do not know about.
- The shared-service seam (`core.member.read` / `core.service_assignment.read`), mirroring `social`.

**Verified**
- 796/796 across `src/rbac` + `src/modules/monitoring` against live Postgres RLS and live Cerbos,
  with **zero skips** — the DB-backed half of this drift is invisible to CI, which has no test DB.

### platform-nest `0.22.0` — 2026-08-13 — IAM authorization hardening

**Fixed**
- `group_executive` was denied on five kinds that folded a global-scope-only role into an
  `inTenant` gate it can never satisfy (IAM-TRAP4).
- `inviteUser` minted a grant at company scope with no scope check, letting a company admin mint a
  247-permission bundle. Both writers now share one guard; a static sweep fails on any new
  unguarded writer (IAM-SEC-05).
- Three deployed permission mirrors over-granted: `automation_approval.{read,decide}` let an
  hr_manager act outside HR, and `hr_record.export` sat one assurance tier below its role arm,
  letting a no-MFA session export raw employee records (IAM-04-REG1/REG2).
- A missing `amr` claim was indistinguishable from a weak login, capping every session below the
  high-assurance tier with nothing to alert on (IAM-MFA-01).

**Added**
- Resolution-source filter: permissions are dropped from any grant at a scope the role cannot
  satisfy, closing the class rather than a kind. Role→scope map generated from `derived_roles.yaml`
  and byte-identity-guarded (IAM-SEC-06).
- Invoice maker/checker seam: `approve` action, creator/approver attribution, `invoice_revisions`
  snapshot history across all four write paths, and the first `EFFECT_DENY` rule in the policy
  repository so no principal — superadmin included — approves their own invoice (IAM-GAP-01/02).
- `hr.leave.decide`, a dedicated decision right for leave, scoped to leave rows only.
- Permission arm on 11 social actions; `portal` remains blocked on a structural hazard gate.
- Mirror-reach invariant test: every bundle holder of a mirrored key must already have
  equal-or-wider role-arm reach.

**Note** — the high-assurance tier is unreachable until the Keycloak AMR mapper is added; see
`infra/runbooks/enable-mfa.md`. One legacy draft invoice has no recorded creator and needs an
operator step before it can be approved or sent.


Per-module changes made between cuts, recorded here so they are not lost the way `0028a`/`0030a`/
`0031a`/`0086a`/`0087a`/`0089a` were (see the LOG GAPs below) — no tag exists yet for these, so no row
is added to the App release log table until one is cut.

- **2026-08-21 — SMM-15**, `social-media 0.5.11 -> 0.5.12` (IN PROGRESS, medior). `pullInbox` —
  idempotent, per-post comment sync into `social_inbox_threads`/`social_inbox_messages`, unblocked by
  SMM-38c's LinkedIn `pullComments`. New `inbox-sync-job.ts`; no migration. Walks
  `social_post_variants` rows carrying a `provider_post_id`, calling `listComments` once per post (the
  port's own per-post keying), cursored on each thread's `last_message_at`. Idempotent on 0105's own
  two unique keys, proven by running the same pull twice (one thread, zero duplicate messages). Quota
  bounded by a SELF-IMPOSED `maxPostsPerAccountPerRun` cap (never an invented vendor limit — neither
  network's Standard-tier rate limit is published, D-23). Distinguishes `unsupported` (driver lacks
  `inbox_read`) from a genuinely empty pull — both proven separately. Writes respect 0113's own
  purge-marker CHECKs (never re-populate an already-purged thread's excerpt) without any purge-side
  change. Module-GUC self-declared and regression-pinned. Test counts: **502/0/5** (baseline
  **494/0/5**, measured directly by stashing this ticket's changes; +8 new, all in the new
  `inbox-sync-job.test.ts`, also re-run alone). `tsc --noEmit` clean; all four migration/withTenants
  linters green (no migration). `main.ts` NOT edited (off-limits) — the wiring line is reported to the
  orchestrator. Full detail: `docs/modules/MODULES.md`'s social-media 0.5.12 entry,
  `docs/plans/smm-tracker.md`'s P2 row.

- **2026-08-21 — SMM-38e closing pass**, `social-media 0.5.10 -> 0.5.11` (IN PROGRESS, senior-be). The
  two gaps 38e's own evidence reported to the architect rather than deciding, both closed by
  ADDITIVE, OPTIONAL port members (`types.ts`) — never a special case in `dispatch.ts`, never a
  hand-maintained deny-list in `registry.ts`. **The upload-terminal gap**:
  `SocialPublisher.isUploadTerminalFor(network)` — `direct.ts` declares `true` for YouTube only (a
  `videos.insert` call IS the post); `dispatch.ts#dispatchApprovedPublish` consults it and, when true,
  stamps the upload's OWN returned id as `provider_post_id` through SMM-10's SAME single-transaction
  stamp, and never calls `schedulePost`. **The override-safety gap**:
  `SocialPublisher.coversNetworkCapability(network, capability)` — backed by ONE map on `direct.ts`
  (`NETWORK_CAPABILITIES`) shared with the pre-existing per-method runtime gates;
  `registry.ts#resolvePublisherForCapability` now refuses EAGERLY (typed `capability_unsupported`) any
  override naming a (network, capability) pair the resolved driver does not cover, before any network
  call. Result: `youtube:media_upload=direct` moves from "reported unsafe" to "principle-safe,
  credential-gated only" (same as LinkedIn); `youtube:schedule=direct` (a value nothing previously
  prevented an operator from setting) now refuses at the resolver instead of failing deep inside
  `schedulePost`. Both new members OPTIONAL — absent (Postiz, the mock) means no restriction/never
  terminal, so the no-config default stays inert, proven by every pre-existing `publisher.test.ts`
  case (two rewritten in place to exercise wildcard precedence rather than a now-refused pair, not
  counted as new). Test counts: **494/0/5** (baseline **483/0/5**, measured directly by stashing this
  pass — matches `main`'s own stated 38e figure exactly; +11 new: `dispatch.test.ts` +3,
  `direct.test.ts` +7, `publisher.test.ts` +1). A real regression was found and fixed during this
  pass's own verification, not shipped: a new `direct.test.ts` case reused the shared module-level
  `unreachableFetch` mock with a non-empty approval id, polluting an earlier-declared test's
  zero-calls assertion — fixed with a locally-scoped stub. Full detail: `docs/modules/MODULES.md`'s
  social-media 0.5.11 entry, `docs/plans/smm-tracker.md`'s PD row,
  `docs/modules/social-capability-inventory.md`'s "Driver per capability" section.

- **2026-08-21 — SMM-33/24 gap-closing pass**, `social-media 0.5.10 -> 0.5.11` (IN PROGRESS). The two
  agentic-exit-bar gaps SMM-33's capability inventory named plainly, closed. **Gap 1**: three new MCP
  tools on `socialModule.mcpTools` (`modules/social/index.ts`) — `social.requestClientReview`
  (write, impact `'medium'` — the first moment content crosses the client trust boundary, so an
  automation/agent principal suspends into WS4), `social.getClientReview` (plain read, no
  write/impact pair), `social.withdrawClientReview` (write, impact `'low'` — corrective, never
  notifies the client) — each fronting the SAME `authorize()` call its existing `social.controller.ts`
  endpoint (SMM-31) already runs, nothing loosened. The portal decide stays undeclared, confirmed:
  no portal capability is ever an MCP tool in this program, regression-pinned in `social.test.ts`.
  **Gap 2**: `applyPostStatuses` (`post-status-sync-job.ts`) — the ONE function both the webhook
  intake and the safety poll share for the network's own authoritative `'published'`/`'failed'`
  status — now calls `writeActivity` with `actor_id = NULL` (the honest "system/service" attribution
  the `activities` table's own column comment already names), never a human who merely last touched
  the row. Fires AFTER the update transaction commits, matching `dispatch.ts`/`pm.controller.ts`'s
  own non-nested sequencing. Regression tests driven RED first (verified by temporarily removing the
  `writeActivity` call and re-running — all four new assertions failed exactly as predicted). No
  migration, no Cerbos change. Test counts: **483/0/5**, unchanged from baseline (**483/0/5**,
  measured directly by stashing this pass) because the new assertions extend existing `it()` cases
  rather than adding new ones. Full detail: `docs/modules/MODULES.md`'s social-media 0.5.11 entry,
  `docs/plans/smm-tracker.md`'s P2 section.

- **2026-08-21 — senior-uiux**, `social-media 0.5.10` (no version change — a UI-only closure, see
  `docs/modules/MODULES.md`'s dated addendum under the same version). The AGPL-3.0 §13 source-offer
  for Postiz, an open item with no ticket number since SMM-24's docs pass, closed: new
  `platform-ui/src/components/social/SourceOfferNotice.tsx`, rendered from
  `departments/[deptId]/layout.tsx` gated on `toolkitFor(dept.name).slug === "social-media"` — the
  department's own console, not the console-wide staff shell the prior seat had recommended, since
  every other department never calls Postiz. Copy promises "the source for exactly what we run"
  rather than naming a version or "unmodified", so it stays true once D-21's still-unapplied fork
  exception lands (only the link target moves then). Driven in a real browser: present with a
  resolving link on Social Media's Home/Calendar/Composer, absent on Web Dev. `tsc --noEmit` clean;
  `platform-ui` suite unchanged, 2444/0/0 measured both with and without the change.

- **2026-08-21 — SMM-38 phase 38e**, `social-media 0.5.9 -> 0.5.10` (IN PROGRESS). The flip's three
  gaps, closed. **Gap 1** (the crux): new `provisioning.ts#resolveDispatchOrgHandle` — a SEPARATE,
  capability-aware resolver (not a widened `openOrg`) that `dispatch.ts` now calls for `media_upload`
  and `schedule`; when `resolvePublisherForCapability` names `direct`, resolves a REAL OAuth grant via
  `oauth-tokens.ts#resolveActiveAccessToken` and builds the `direct`-shaped handle (LinkedIn's org URN
  from 38c's own `config.social.direct.linkedin.organizationUrn`, sufficient since `direct`-routed
  connects are own-brand-only). Proven live end to end (`dispatch.test.ts` D1–D4: a real token row,
  per-CAPABILITY routing, fail-closed on a revoked grant). Found and fixed a real gap while wiring
  this: `completeLinkedInConnect`/`completeYouTubeConnect` never set `postiz_integration_id`, which
  would have failed `assertDispatchChain`'s generic connected-account gate for every `direct`
  account — fixed with a self-describing sentinel (`'direct:linkedin'`/`'direct:youtube'`), not a
  relaxed gate. **Gap 2**: `uploadMedia`'s `file` param gains optional `title`/`description`
  (`types.ts`); `dispatch.ts#resolveEngineMedia` derives both from the variant's own `body` for a
  YouTube upload. **Gap 3**: new `YouTubeQuotaStore` seam (`youtube-quota.ts`) —
  `defaultYouTubeQuotaStore()` wraps the untouched 38d singleton (zero test changes);
  `createDbYouTubeQuotaStore()` is a durable, atomic, GLOBAL-table (no RLS, D-4 reasoning) store
  `boot.ts` wires in for the real app. New migration `202608210411_social_youtube_quota_usage.sql`.
  **The flip's default stays empty** — no capability-driver override shipped; the recommended
  override (staging, once credentialed) covers LinkedIn's three capabilities only, deliberately
  EXCLUDING `youtube:media_upload`/`youtube:schedule` — YouTube's "upload IS publish" shape collides
  with `dispatch.ts`'s unconditional upload-then-schedule flow, reported to the architect as an open
  question rather than wired around. Capability inventory
  (`docs/modules/social-capability-inventory.md`) gained the required "driver per capability" table.
  Test counts: **483/0/5** (baseline **470/0/5**, measured directly by stashing this pass — matches
  `main`'s own stated figure exactly; +13 new). Full detail: `docs/modules/MODULES.md`'s social-media
  0.5.10 entry, `docs/plans/smm-tracker.md`'s PD row.

- **2026-08-21 — SMM-38 phase 38d**, `social-media 0.5.8 -> 0.5.9` (IN PROGRESS). YouTube on the
  `direct` driver. Resolved the `uploadMedia(org, file)` network-routing collision 38c named by
  widening the port to `uploadMedia(org, file, network)` — updated in `types.ts`, `postiz.ts`,
  `direct.ts`, `mock-driver.ts`, `publisher-contract.ts`, and the one call site
  (`dispatch.ts#resolveEngineMedia`). New `publisher/youtube-client.ts` (Google token exchange, the
  resumable-upload protocol, `commentThreads.list` — deliberately NOT reusing
  `core/google-oauth/token-endpoint-client.ts`, a different Google Cloud app), `publisher/youtube-oauth.ts`
  + `youtube-oauth.controller.ts` (mirrors `linkedin-oauth.ts`'s signed-state/readiness/controller
  shape exactly, `STATE_PREFIX="yts1"`), `publisher/youtube-quota.ts` (self-tracked accounting
  against SMM-37's three real buckets — cited constants for the caps, an in-memory per-day counter
  for `used`, since Google exposes no live "remaining quota" read). `direct.ts`'s
  `DIRECT_CAPABILITIES` gains `quota_probe`; YouTube gets `media_upload`/`inbox_read`/`quota_probe`
  but deliberately NOT `schedule` (a `videos.insert` call IS the post for this driver — no separate
  publish step). `listComments` tells LinkedIn/YouTube apart by the network's OWN id shape
  (`urn:li:...` vs. a bare video id), a narrower, deliberate alternative to widening that port method
  too. No migration. Test counts: **470/0/5** (baseline **420/0/5**, measured directly — not the
  ticket brief's stated figure). Full detail: `docs/modules/MODULES.md`'s social-media 0.5.9 entry,
  `docs/plans/smm-tracker.md`'s PD row.
- **2026-08-21 — SMM-38 phase 38c**, `social-media 0.5.7 -> 0.5.8` (IN PROGRESS). LinkedIn on the
  `direct` driver — the phase that unblocks P2's inbox. OAuth grant flow (new
  `publisher/linkedin-oauth.ts` + `linkedin-oauth.controller.ts`, tenant-agnostic callback mirroring
  `SearchGoogleOauthCallbackController`), org-page publish + the 3-step media asset flow + comment
  read (new `publisher/linkedin-client.ts`; `direct.ts`'s `DIRECT_CAPABILITIES` now
  `schedule`/`media_upload`/`inbox_read`, LinkedIn only — every other network still refuses
  `capability_unsupported`), and `registerTokenRefresher('linkedin', ...)`. No migration — reuses
  0105's `social_accounts` and the already-merged `social_oauth_tokens` (202608201518).
  `registry.ts#resolvePublisher`'s empty-registry heuristic fixed (`anyNonDirectRegistered`) so
  `direct` can now be registered at boot without flipping a Postiz-unconfigured deployment's
  `publisher_not_configured` into `unknown_publisher` — proven behaviourally inert on every live
  path today regardless. A named architecture gap for 38e: `direct.ts#connectUrl` still refuses
  (the port's `OrgHandle`-based signature carries no tenantId/accountId a real OAuth flow needs), so
  no live call site yet resolves a LinkedIn token and builds the handle `schedulePost`/`uploadMedia`
  need. Full detail: `docs/modules/MODULES.md`'s social-media 0.5.8 entry, `docs/plans/smm-tracker.md`'s
  PD row.
- **2026-08-20 — SMM-33 + SMM-24 (docs half)**, `social-media 0.5.6` (docs-only, no version change).
  Capability inventory + eval register (SMM-33) and the outstanding BFF-rows/AGPL-gap half of
  SMM-24. New `docs/modules/social-capability-inventory.md`: one row per capability (endpoint · MCP
  tool · D14 impact class · typed refusal vocabulary · `work_activity` row) across P0 through the
  merged half of P3, built from `social.controller.ts` / `social-client-review-portal.controller.ts`
  / `modules/social/index.ts` / `approval-executables.ts` directly, companion to SMM-14's proven
  golden-case table rather than a duplicate. Two structural gaps stated plainly rather than smoothed
  over: the entire client-review capability group has no MCP tool, and the post-status webhook
  callback writes no `work_activity` row with no stated reason. Corrected the MCP tool count (18,
  not the 17 the tracker had estimated). `docs/FRONTEND-BFF-CONTRACT.md` §19: added the dispatch
  endpoint row, the webhook-intake row, and SMM-21's two metrics-read rows — each verified against
  the controller source read directly this pass, none carried over from a prior claim. The AGPL §13
  source-offer gap was RE-CONFIRMED (staff console has no footer surface anywhere) and a placement
  recommended (`platform-ui/src/app/(app)/layout.tsx`, mirroring `PortalShell.tsx`'s own footer) —
  not built; left for the owner + senior-uiux. This worktree fast-forwarded onto `main` first
  (clean, no divergent commits) to pick up SMM-21's already-merged commit before reading any code —
  otherwise this pass would have inventoried a tree missing `metrics-job.ts` entirely. Full detail:
  `docs/plans/smm-tracker.md`'s SMM-33/SMM-24 evidence block.
- **2026-08-20 — SMM-21**, `social-media 0.5.5 -> 0.5.6`, `platform-ui 0.28.3 -> 0.28.4` (IN
  PROGRESS). Metrics: `pullMetrics` nightly ingest + the Analytics tab. Schema (`social_metrics_daily`/
  `social_post_metrics`) was already in `0105` — no migration. New
  `platform-nest/src/modules/social/metrics-job.ts`, shaped like `inbox-retention-job.ts`/
  `post-status-sync-job.ts`: `withGlobal` tenant list → per-tenant read (own declared module scope)
  → the driver call OUTSIDE any transaction → write (own declared module scope again), in two
  independent halves (account daily upsert on `UNIQUE(account_id, date)`; post-metrics APPEND, never
  upsert — 0105 designs that table as snapshot history). Dark by default via
  `SOCIAL_METRICS_PULL_ENABLED`/`SOCIAL_METRICS_PULL_INTERVAL_MS` read directly from `process.env`
  (not `config.ts` — that file and `main.ts` were held by SMM-38a's parallel worktree); the exact
  `main.ts` registration line is handed to the merge orchestrator rather than wired here. **The
  module GUC, the ticket's own named risk**: every write runs through `applyAccountDailyMetrics`/
  `appendPostMetrics`, each declaring its own `declareSocialModuleScope` — regression-pinned by
  `metrics-job.test.ts`'s (T1)/(T5), which call them with no `{modules:['social']}` at the call site
  and assert a real row exists. **No invented numbers**: every counter is optional end to end (the
  `SocialPublisher` port, the two new tables, the two new BFF routes, and `AnalyticsPanel.tsx`'s
  `fmtMetric`) — an absent field is SQL NULL / `null` / an em dash, never coerced to `0`, proven at
  the DB layer, the HTTP layer, and in a real browser. Two new read-only routes on
  `social.controller.ts` (`GET metrics/daily`, `GET metrics/posts`, both requiring `engagementId` —
  accounts are client-scoped, not engagement-scoped), with `date` selected via `::text` to dodge the
  node-pg `Date`-object timezone-shift trap `pm.controller.ts` already guards against (caught live
  by `metrics-endpoints.test.ts` before it shipped). Frontend: `DailyMetricRow`/`PostMetricRow`
  (`socialShared.ts`), `listDailyMetrics`/`listPostMetrics` (`lib/social.ts`), `AnalyticsPanel.tsx`,
  and `departments/[deptId]/analytics/page.tsx` now renders real tables instead of `BackendPending`.
  DEMO_MODE: `dailyMetrics`/`postMetrics` seeded onto the same `globalThis`-pinned `SocialStore`,
  deliberately partial. **Driven in a real browser** (`DEMO_MODE=1 npm run dev`, Playwright):
  confirmed real numbers render for followers/impressions while reach/engagements/link-clicks/video-
  views render as em dashes on the day the engine reported only two counters, full numbers on the
  following two days, a post-metrics row with `saves` absent rendering as a dash while every other
  counter is a real number, and the engagement filter correctly showing the SAME client-scoped
  account series under both seeded engagements. **337 / 0 / 0** `platform-nest` (was 318/0/0, +19:
  `metrics-job.test.ts` 13, `metrics-endpoints.test.ts` 6), **2399 / 0 / 0** `platform-ui` (was
  2392/0/0, +7). `tsc --noEmit` clean both sides. Full detail: `docs/plans/smm-tracker.md`'s SMM-21
  evidence block, `docs/modules/MODULES.md`'s social-media 0.5.5 entry.

- **2026-08-20 — SMM-38 phase 38a**, `social-media 0.5.4 -> 0.5.5` (IN PROGRESS). D-20's `direct`
  `SocialPublisher` driver — the skeleton + the per-capability switch, design addendum §PD. **This
  phase is deliberately INERT: every capability still resolves to `postiz`, and nothing in the
  running system's behaviour changed.** `publisher/direct.ts` (new) implements the port's full shape
  and refuses every member with a typed `capability_unsupported` — no OAuth, no token storage, no
  media upload, no network call (38b/38c/38d's job); its `capabilities` set is EMPTY, matching the
  "absent, not throwing" discipline the port already uses for `listComments`/`sendReply`.
  `publisher/registry.ts`'s new `resolvePublisherForCapability(orgDriver, capability)` is a NEW
  dimension laid on top of `resolvePublisher`'s existing per-ORG resolution
  (`social_publisher_orgs.driver`, unchanged, still CHECK-constrained to `'postiz'`/`'mixpost'` — no
  migration): with no entry in the new `config.social.publisher.capabilityDrivers` override map
  (parsed from `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS`, empty by default) it falls straight through to
  `resolvePublisher(orgDriver)`, the exact call every existing caller already makes — that
  fallthrough IS the inertness. An override naming an unregistered driver still REFUSES
  (`unknown_publisher`), preserving `resolvePublisher`'s own honor-or-refuse property at the new
  dimension. `types.ts`'s `PublisherKey` widens to admit `'direct'` (a type-level change only; the
  DB column does not admit it). `direct` is deliberately **not** registered in `main.ts`/`boot.ts`
  this phase — see `direct.ts`'s header: registering it unconditionally would make the registry
  non-empty even with Postiz unconfigured, silently changing `resolvePublisher`'s refusal from
  `publisher_not_configured` to `unknown_publisher` for every org, which is exactly the live-
  behaviour change this phase forbids. `publisher-contract.ts` (new) pulls the port's behavioural
  contract out of `publisher.test.ts` into a parameterized `runPublisherContractSuite`, run against
  `postiz`, the mock, and `direct` — a capability gap asserts the typed refusal, never a skip.
  `publisher.test.ts` gained the two non-`direct` suite runs plus 4 tests for the switch itself;
  `direct.test.ts` (new) adds 6 driver-specific tests plus its own contract-suite run. **346 / 0 / 0**
  across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts` +
  `social-client-review-portal.controller.test.ts` (was 318/0/0, +28 new tests). `tsc --noEmit`
  clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/`lint:migration-names` green.
  `test:iam-chain-alignment` green (25/25, unaffected — no IAM/Cerbos touched). Full detail:
  `docs/modules/MODULES.md`'s social-media 0.5.5 entry, `docs/plans/smm-tracker.md`'s PD row.

- **2026-08-20 — SMM-32**, `social-media 0.5.3 -> 0.5.4`, `platform-ui 0.27.0 -> 0.28.0` (IN
  PROGRESS). Client-review portal UI + composer/calendar reflection (D-16) — the other half of
  SMM-31, `platform-ui` only, no migration/Cerbos/backend-route change. Portal:
  `(portal)/portal/social-reviews{,/[reviewId]}` (list + detail/decide,
  `PortalSocialReviewDecideForm` via `useActionState` so a genuine 409 is SEEN, not swallowed), new
  `lib/portal.ts`/`portal-data.ts`/`portalActions.ts` members, an un-badged "Post reviews" tab
  (a real pending count would need a new always-on fetch — flagged, not invented). Staff:
  `socialShared.ts` mirrors `CLIENT_REVIEW_REFUSAL` (5 tokens) by hand plus a new
  `evaluateClientReviewState` (client-safe re-implementation of
  `evaluateClientReviewPrecondition`, including the staleness check against the LIVE
  `argsSha256`), widens `PublishPreconditionResult.stage` to accept `"client_review"` (the
  EXISTING "Check now" preview button renders it with zero new code once the type/labels exist),
  `VariantCard.tsx`'s new `ClientReviewPanel` (ask/re-ask/withdraw), `CalendarGrid.tsx`'s
  per-variant chips (RAW status only — the roll-up carries no `argsSha256`, so the calendar never
  claims `stale`; only the Composer does). Three new `rbac.ts` capabilities
  (`social.client_review.{read,request,withdraw}`), verified against
  `role-permission-bundles.json` (`social_staff` read+request only, `social_manager`/
  `company_admin`/`manager`/`platform_admin` all three), plus matching `rbac-capability-map.ts`
  entries so the 742-case parity suite covers them. **Found and closed a real, pre-existing
  DEMO_MODE gap** (not introduced by this ticket): `demoSocial.ts` had no `GET
  engagements/:id/scope` route, so `getEngagementScope` silently degraded to the `EMPTY_SCOPE`
  fallback everywhere in DEMO_MODE — invisible for the Composer's own panel but it fully defeated
  the Calendar's chip feature (gated on that exact flag) and silently affected the pre-existing
  engagement-scope editor page too. DEMO_MODE state added `globalThis`-pinned from the start (a
  `clientReviews` array on the shared `SocialStore`, a second `requiresClientOk:true` engagement
  kept separate from SMM-12's own demo engagement, and a new `socialClientReviewPortalDemo`
  dispatcher answering the portal's routes off the SAME store). **Driven in a real browser**
  (`DEMO_MODE=1 npm run dev`, Playwright): all 5 refusal tokens rendered as themselves in the
  Composer; the full staff request→pending→withdraw→re-request loop; the portal list+decide flow
  as `demo-client`; and the idempotent-decision guarantee proven as a genuine two-tab race (tab 1
  approves, tab 2's stale submit of a DIFFERENT decision gets the honest 409 conflict message,
  never a crash; reload shows no decide control anywhere on the page) plus cross-session
  consistency (a separate staff session's Composer immediately reflected the portal decision, and
  the precondition preview correctly advanced past the client-review gate to the next real
  blocker). **2392 / 0 / 0** `platform-ui` (was 2329/0/0, +63), `tsc --noEmit` clean.
  `next build` deliberately not re-run this pass. Full detail: `docs/plans/smm-tracker.md`'s
  SMM-32 evidence block, `docs/modules/MODULES.md`'s social-media 0.5.4 entry,
  `docs/FRONTEND-BFF-CONTRACT.md` §16h/§19.

- **2026-08-20 — SMM-31**, `social-media 0.5.2 -> 0.5.3` (IN PROGRESS). Client-review stage backend
  (D-16): `social_post_client_reviews` (already schema'd by `0105`, plain-tenant-wall — see that
  migration's own header for why, restated in `modules/social/client-review.ts`'s header). No
  migration and no Cerbos change — `0106` already seeded `social.client_review.{read,request,
  withdraw}` + `portal.approve_post`, and `resource_social_client_review.yaml` /
  `resource_portal.yaml` already carried the actions. STAFF side (`social.controller.ts`):
  `POST/GET/POST .../variants/:id/client-review[/withdraw]`, idempotent request-as-upsert (one row
  per variant, forever — 0105's `UNIQUE(variant_id)`), manager-tier withdraw. PORTAL side (new
  `SocialClientReviewPortalController`, modelled on `PortalController.decideGate`):
  `GET/POST .../portal/social-reviews[/:id/decide]`, ownership resolved before the guarded
  `UPDATE ... WHERE status='pending'` (idempotent: a retry with the SAME decision is a 200 no-op, a
  DIFFERENT decision is a 409, never a silent flip). The submission precondition
  (`evaluateClientReviewPrecondition` + the composed `evaluatePublishPreconditionWithClientReview`)
  is a NEW, SEPARATE gate — NOT a 7th stage in SMM-09's pinned six-stage chain
  (`PUBLISH_PRECONDITION_STAGES` stays `[scope,quota,hash,unconsumed,budget,creator_info]`, unchanged
  and untested-into) — composed in FRONT of it at all three real choke points: the D14 executor's
  precondition, SMM-10's dispatch re-check, and the dry-run endpoint staff actually consult before
  filing a WS4 approval (there is no separate "submit" endpoint in this codebase as of P1). New
  refusal vocabulary `CLIENT_REVIEW_REFUSAL` (5 tokens: `client_review_not_requested/_pending/
  _changes_requested/_withdrawn/_stale`), kept apart from `PUBLISH_REFUSAL` — same separation
  `dispatch.ts`'s own `DISPATCH_REFUSAL` keeps. Notifications ride the ALREADY-DRAINED
  `"social_post_variant"` consumer stream (two new `event-handlers.ts` routes,
  `social.client_review.requested` → client portal contacts, `.decided` → the engagement owner) —
  no `main.ts` change needed, avoiding this module's own most-repeated "registered but never
  invoked" defect. 318/318 in `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts` +
  the new portal controller test (was 289/289), 0 skipped; two of the new tests were driven to FAIL
  first by temporarily deleting the `declareSocialModuleScope` call each new code path needs, then
  restored — the module-GUC regression class, proven rather than asserted. `tsc --noEmit` clean;
  `lint:withtenants`, `lint:migration-rls`, `lint:migration-names` all green; IAM chain-alignment
  suite green. No migration. SMM-32 (portal UI) is next; full detail in `MODULES.md`'s social-media
  0.5.3 entry.

- **2026-08-19 — SMM-39**, `social-media 0.5.0 -> 0.5.1` (IN PROGRESS). `dispatch.ts` actually calls
  `SocialPublisher.uploadMedia` now — SMM-05 built the port method and SMM-10's own "KNOWN
  LIMITATION" comment named the gap by name (`toDispatchMedia` mapped `fileId` onto the engine ref
  verbatim, a placeholder that made any post carrying an attachment fail at the publisher with
  `publisher_http_error`), and no ticket in between ever wired it up. `resolveEngineMedia` reads each
  attachment's bytes out of `files` (plain core tenant wall, NOT `social_*` — conflating that with
  the module GUC is this module's most-repeated trap) and uploads OUTSIDE the claim transaction/
  advisory lock, mirroring SMM-10's own creator-info-fetch discipline. Resolved refs land in a NEW
  additive `uploaded_media jsonb` column (`migrations/0118_social_variant_uploaded_media.sql`) keyed
  by `fileId` — deliberately NOT the hashed `media` column, so resolving an attachment can never
  invalidate the approval it is executing under (D-15). Persisted per-fileId the instant its own
  upload succeeds, so a redispatch after a partial failure never re-uploads what already succeeded.
  A partial failure (attachment 2 of 3) refuses BEFORE `schedulePost` — new token
  `DISPATCH_REFUSAL.mediaUploadFailed`, added to `dispatch.ts`'s own small vocabulary rather than
  `PUBLISH_REFUSAL` (SMM-12/17/22/31's contract) — and the approval is still consumed (SMM-09's
  `neverAutoRetry`). Text-only variants never touch `files`/`storage()`/the driver. No new endpoint;
  `dispatch.test.ts`'s own fixtures had been naming a `fileId` with no `files` row behind it at all
  (exactly the gap this ticket closes) and now attach real rows throughout, plus 3 new cases
  (partial-failure refusal, idempotent-redispatch skip, text-only no-op). 225/225 passing in
  `src/modules/social` (was 222/222), 0 skipped; `tsc --noEmit` clean; `lint:withtenants`,
  `lint:migration-rls`, `lint:postiz-deps` all green. MAP.md regenerated (migration head 0116).

- **2026-08-14 — activity feed gets a time axis, and a working-zone clock**,
  `platform-ui 0.28.2 -> 0.28.3` (IN PROGRESS). Authored on a branch against `0.25.1` and
  renumbered when it merged: `0.25.2`–`0.25.4` had been consumed on `main` by the `0107`/`0109`
  release cuts (`platform-ui 0.25.1 -> 0.26.0 -> 0.27.0`) while this work sat uncommitted.
  Renumbered a SECOND time when PR #4 merged (2026-08-20): `main` had meanwhile taken
  platform-ui to `0.28.0` with SMM-32, so this three-entry chain re-bases onto it and reads
  `0.28.0 -> 0.28.1 -> 0.28.2 -> 0.28.3`. The registry records `0.28.3`.
  **Fixed, and this is the reason to read the
  entry**: `ActivityFeed` formatted every timestamp with `toLocale*(undefined, …)` and it renders
  on the SERVER, so the clock beside each row was the container's UTC — eight hours off the
  working day, silently. Locale and zone are now pinned (`en-GB` / `Asia/Makassar`, the
  `me/inbox` precedent, 24-hour like it), and day GROUPING is pinned to the same zone, so an event
  at 23:30Z lands on the next local day instead of splitting the reader's day in two. `new Date()`
  inside render is gone: "now" is passed in as `nowIso` by the caller (same contract as
  `MyWorkRail`'s precomputed `urgencyTier`), because "Today" decided by the server's clock
  labelled today's rows "Yesterday" for the first eight hours of each local day. Omitting the prop
  drops the relative labels rather than guessing. Also: the day heading was rendered INSIDE the
  first `<li>` of its run, so a screen reader announced "22 Jul" as part of the first entry —
  each day is now its own `<section>` + `<ol>`. **Design**: the feed is Home's only chronological
  block, so it is the only one that can carry a spine — day markers hang off a hairline and each
  entry is a node on it, replacing the per-row bottom border that doubled against the day rules.
  Day markers state their age ("22 Jul · 23 days ago"); the header says 14 August and nothing used
  to bridge the three weeks. Human and machine rows no longer look identical: a cron sat at the
  same weight as a colleague's decision, so rows with no `actorUserId` get a hollow node, no bold
  actor and muted ink — carried by a new explicit `automated` prop, since `actorLabel()` falls
  back to `actorExternal` and a scheduler arrives wearing a name. The repeated per-row source chip
  ("PM" eight times down one column) is gone; the source is on the node (`role="img"` + label).
  The source tag returns for machine rows ONLY, set beside the sentence: tone alone (hollow node,
  muted ink, unbolded actor) still read as "a slightly faint human row", and on a person's row a
  source is a label repeated down the column while on a machine's it is the only thing naming
  which machine acted. Its hollow node went to a 1px border — at 7px a 0.5px outline closes up and
  reads filled, i.e. as a person. Clock times only for today/yesterday. Truncated previews now say
  so. Copy: `objectLabel` turned
  `pm_task` into "Pm task" — a column name in sentence case — so the kinds the generic rule gets
  wrong are mapped ("Task", "QA check", "AI run"). DEV-VERIFIED by driving `/departments/dept-1`
  in both themes; 146 files/2318 tests green, `tsc` clean, `DEMO_MODE=1 next build` exit 0 — all
  run in a throwaway git worktree, because building in the shared checkout overwrites the `.next`
  another session's dev server is live on (it did, once, and cost a `__webpack_modules__ is not a
  function`).
- **2026-08-14 — project-health ring becomes a composition**, `platform-ui 0.28.1 -> 0.28.2`
  (IN PROGRESS). `HealthRingCard` drew a single progress arc that turned rust when the project was
  at risk, so "43% complete" was rendered in the alarm colour — recolouring progress to carry a
  fact progress does not hold. The ring now shows the work's **composition**: every task lands in
  exactly one segment (done · blocked · overdue · on track) via a new
  `ProjectHealth.composition` (`lib/departments.ts`), so risk is a slice of the work rather than a
  stain on the figure. Buckets are a genuine partition — a task that is both blocked and overdue
  counts once, as blocked — deliberately NOT reusing `atRiskReason`'s overlapping counts, which
  are right to double-count and drive decision #12's at-risk line. Segments take the status token
  that already means them (`--status-ok/-critical/-warning`), so no colour enters the system and
  both dark blocks follow for free; on-track work takes `--status-neutral` because its first draft
  in bronze was unseparable from amber overdue at 11px, and because saturation spent on the work
  that needs nothing is backwards. A legend in **counts, not percentages** (single-digit
  denominators) makes the ring readable, and it replaces the `dl` that sat beside the ring saying
  nothing about it. Card leads with the open count instead of the project name; at-risk is now a
  rust rule down the leading edge — the `.dept-rail__item--waiting` idiom, same meaning — and the
  reason line is dropped where the legend states it more precisely (kept as the fallback for a
  caller that passes no composition). **Fixed**: `toLocaleDateString(undefined, …)` on the
  milestone date, the hydration-divergence trap CLAUDE.md names, now pinned to en-GB/UTC like
  `charts/chartHover.ts::fmtDate`; the milestone date is one nowrap token, because the caption
  broke between "20" and "Jul" at laptop width. **Spacing**: the card's uniform 10px gap spaced
  four things that are not peers — title / figure / the figure's caption / the ring block — so the
  gaps are now set per relationship (figure and its caption tight at 4px, the ring block given 20).
  And the grid's width cap moved from the CARD to the TRACK: a `max-width` card inside a stretching
  `1fr` track left the leftover width sitting *between* the two cards, drifting them ~90px apart.
  Tracks are `auto-fit minmax(260px, 340px)` (auto-FIT so an unused track collapses instead of
  standing as a phantom empty column) with a tighter 278px cap under 1340px viewport, where the
  rail leaves a 578px main column that two 340s cannot share. DEV-VERIFIED by driving
  `/departments/dept-1` in `DEMO_MODE=1` at 1280/1440/1680 and in **both** themes, reading the
  rendered rings: 146 files/2313 tests green, `tsc` clean, `DEMO_MODE=1 next build` exit 0.
- **2026-08-14 — department-console KPI strip craft pass**, `platform-ui 0.28.0 -> 0.28.1`
  (IN PROGRESS). Four defects in `components/departments/KpiStrip.tsx` + `departments.css`, all
  visible on `/departments/[deptId]`: (1) KPI numerals were set in the display face, whose `1` is a
  flagless vertical stroke and rendered as a capital **I** at 32px — in the one component whose job
  is stating counts. Numerals move to the body face with `lining-nums tabular-nums`; the display
  face keeps headings. (2) Only the Progress tile owned a bar, so its caption sat a line below the
  other three; every tile now reserves the bar slot (`.dept-kpi__bar--empty`) and the tile is an
  explicit 4-row grid, so the four captions share one baseline whether or not a caption is passed.
  (3) The four boxed `?` hints carried the same visual weight as the labels they annotate — the box
  is dropped **in this scope only** (`hint.css` defaults untouched elsewhere), with hint.css's 0.55
  opacity overridden so the unboxed glyph does not compound below AA, and the 44px coarse-pointer
  target restored. (4) `.dept-kpi__label` used `opacity: 0.6` over an inherited ink, the ad-hoc
  alpha `colors.css` rule 3 forbids → `--ink-subtle`; padding `22px`/gap `14px` → `--space-20`/
  `--card-gap`, per spacing.css's no-arbitrary-numbers rule. Copy: Blocked's caption said "needs a
  look" — it now states the shape of the problem ("1 task, 1 project"), fed by a new
  `DeptKpis.blockedProjects` (distinct projects the blocked tasks span, `lib/departments.ts`);
  callers that pass no spread keep the generic line rather than a guessed count. DEV-VERIFIED by
  driving `/departments/dept-1` in `DEMO_MODE=1` and reading the rendered strip, not only the
  suite: 146 files/2304 tests green, `tsc` clean for everything touched, `DEMO_MODE=1 next build`
  exit 0.
- **2026-08-13 — SMM-05**, `social-media 0.4.1 -> 0.5.0` (IN PROGRESS). The `SocialPublisher` port,
  its Postiz HTTP+JSON driver, `social_publisher_orgs` provisioning, connector-registry sync and the
  cross-client dispatch-chain check land in `platform-nest/src/modules/social/publisher/`. **This is
  the AGPL containment line in code**, and it is now a build gate: `npm run lint:postiz-deps` (new,
  wired into CI's `platform-nest` job) fails on any Postiz package or module import anywhere in
  `src/` — design §11 asked for exactly this ("lint-enforced zero Postiz deps") and it had never
  existed. Provisioning is idempotent and lets 0105's two UNIQUEs decide, including the GLOBAL
  `UNIQUE (postiz_org_id)` whose violation is invisible to a SELECT under RLS. The registry mirrors
  status/quota/capabilities/health and **never a token** (D-5); Instagram quota is read LIVE from the
  account or recorded UNKNOWN — never the obsolete "25/24h" constant, pinned by a source-grepping
  test. `capabilities.unsupported` distinguishes a permanent NETWORK gap (TikTok comments, §A4h;
  LinkedIn/YouTube/TikTok DMs, §A4e/§A4g/§A4h) from a fixable DRIVER gap (Postiz has zero inbound
  surface for any network, spike §8b) from `unverified`. The cross-client FK-chain check refuses
  fail-closed with an audit line and has its own adversarial test. Config plumbing absorbs **SMM-06**
  (base URL, alias-resolved org keys, split timeouts, per-network deployment flags) and **boots
  cleanly with Postiz unreachable** — the one boot refusal is a base URL that looks PUBLIC. Three
  design-§05 members were corrected against the spike's findings rather than carried: `createOrg` is
  unimplementable (no such route), `listComments`/`sendReply` are optional and unimplemented, and
  `getPostStatus` is a batched date-ranged sweep. **No publish path is built** — `social.publishPost`
  and the D14 entry remain SMM-09's. No migration; new directory + 3 routes, so MAP.md regenerated.
  163/163 passing (`npx vitest run src/modules/social`, 59 new). BFF §19 extended.

- **2026-08-13 — SMM-37**, `social-media 0.4.0 -> 0.4.1` (IN PROGRESS). Three pre-publish
  validation-engine gaps closed in `platform-nest/src/modules/social/media-rules.ts` per
  `docs/blueprints/smm-design-addendum-2026-08-12.md` §A4f item 2 / §A4i: media FORMAT is now
  checked (Instagram JPEG-only; refuse, do not transcode — no transcode backend exists anywhere in
  the estate), Facebook's native 10-minute-to-30-day schedule window is now checked (Facebook only —
  no other network in the research trail documents a bound), and `QuotaSnapshot`'s YouTube shape
  moved from the old single 10,000-unit-pool model to the real three-bucket model (100 `search.list`
  calls/day, 100 `videos.insert` calls/day, 10,000 units for the rest) so a reading no longer reports
  headroom while uploads are already blocked. Full detail in `MODULES.md`'s social-media 0.4.1 entry.
  No migration, no new route/controller (MAP.md unaffected). 104/104 tests passing
  (`npx vitest run src/modules/social`, 36 in `media-rules.test.ts`, was 17). BFF contract §19
  extended with `unsupported_media_format`, `media_format_unknown`, `facebook_schedule_window`.

## App release log

Every cut app version and the exact module manifest it contains, so any deployed build can be
reconstructed from this table alone. Format defined in [`VERSIONING.md`](./VERSIONING.md).

> **⚠ LOG GAP (noted 2026-08-04).** Tags `alpha-01.009.0028a`, `alpha-01.011.0030a` and
> `alpha-01.012.0031a` exist in git but have **no entry here** — rule 2 ("every app version records its
> module manifest") was skipped by the concurrent sessions that cut them, so those three builds are not
> reconstructible from this file. Not back-filled here because the contents are not known to this
> session; whoever cut them should add them. Related drift found at the same time: the **App version**
> line in `MODULES.md` had been left at `01.005.0021a` — eight releases stale — while `/VERSION` was at
> `01.012.0031a`. Per VERSIONING rule 5 `/VERSION` is authoritative; the `MODULES.md` line is now
> corrected and should be moved with every cut.

> **⚠ TAG/COMMIT MISMATCH (found 2026-08-06, this cut).** The pushed tag `alpha-01.020.0052a`
> resolves to commit `ccb2c04` (the OBS-01 observability commit), **not** `d78319d` — the commit
> that actually wrote the release entry below and the manifest it records. `d78319d` is `ccb2c04`'s
> parent, so the tagged/deployed build for `0052a` already contains `observability 0.6.1` (OBS-01),
> one commit past what the entry below manifests (`0.6.0`). Confirmed by diffing
> `git show alpha-01.020.0052a:docs/modules/MODULES.md` against `HEAD` — only the `infra` row
> differs. Practical effect: this session's baseline for "what's new" is the **tag's real content**
> (which already carries OBS-01), not the recorded manifest — so OBS-01 is not re-counted below.
> Not corrected retroactively (moving a pushed, already-deployed tag is its own risk); flagging so
> the next session doesn't re-diagnose the same gap.

### `Alpha 01.067.0144a` - 2026-08-23 - the work that was finished but never left the laptop

Manifest (counter +1, 0143 -> 0144): `platform-nest 0.36.2 -> 0.36.3`, `platform-ui 0.43.0 ->
0.43.1`, `mcp-hub 0.11.0 -> 0.11.1`, `observability 0.6.1 -> 0.6.2`, `infra 0.8.6 -> 0.8.7`.

**This cut is mostly recovery, not new capability.** Ten commits that were complete and correct on a
developer machine and had simply never been pushed — including `6d09855`, the fix for the CI failure
that was itself keeping main red. `platform-nest` and `docs-map` had both been failing since the
`0141a` cut for that reason: the repair existed, it just was not on the remote. Worth stating plainly
because the symptom ("changes are not live") pointed at the pipeline, and the pipeline was fine
throughout — three releases deployed successfully while this work sat unpushed.

Two gates were also genuinely broken and are now fixed:

- **`docs-map` was structurally unclearable.** It validates `docs/MAP.md`, but lived in `ci.yml`
  behind `paths-ignore: ["**/*.md", "docs/**"]`. `MAP.md` is generated from the whole repo tree, so a
  code push can stale it — while the regenerated MAP that fixes it is a docs-only change that ci.yml
  ignores. Once red it stayed red until unrelated code landed. Now its own workflow, own concurrency
  group (sharing ci's `cancel-in-progress` meant a docs push could cancel a full CI run), no filter.
- **D14-17 (A1) was firing on test pollution, not on a real defect.** The executable-approval
  registry is a module singleton; `resetExecutableApprovals()` clears all nine areas, and the suites
  that reset it restored only their own. SMM-35 added `social.createReplyDraft` to
  `ASSISTANT_AGENT_WRITE_TOOLS`, so the gate began asserting on a tool no resetting suite restored —
  passing alone, failing after a resetting suite. Production was never affected. Root cause was
  structural: nine bootstraps, nine bare module-load calls, no single place naming the set, and a doc
  that listed three of the nine. Now one `registerAllExecutableApprovals()`, used by both boot and
  test-restore, so it cannot drift again. A gate that cries wolf is a gate you stop trusting.

Also lands, all additive: `agent_registry` and `risk_policy` + `infra_hosts.risk_weight` (the Hermes
agent roster and risk ladder as DATA, not commits); `mcp-hub/src/risk.ts`, the pure tier algebra, not
yet imported by any caller so it carries no runtime effect; `hermes-config/` (template + installer
only — no secrets, `config.yaml.tmpl` references `${GAIADA_HUB_TOKEN}` by name) and `persona/`;
33 new tests; and `synthetic-prober.exe` finally gitignored.

**Observability:** `default-multi` — the receiver for `severity: ticket` and everything unmatched —
had no working transport, so `GatewayBudgetNearCap` (~13 h/day) and `SyntheticJourneyFailing`
(~14 h/day) fired for over 24 h and were delivered nowhere. It now carries a webhook leg. Note this
config lives on the SumoPod box (project `gaiada-obs`), NOT in the tag deploy — verified already
delivering there, 35 messages in 24 h.

**Full module manifest** (rule 2):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.36.3`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.1` |
| **platform-ui** | **`0.43.1`** | ai-agents | `0.8.1` | social-media | `0.5.31` |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| **mcp-hub** | **`0.11.1`** | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.2` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | report-renderer | `0.1.0` |
| **observability** | **`0.6.2`** | **infra** | **`0.8.7`** | mail | `0.0.19` |
| monitoring | `0.2.0` | | | | |

**Verification:** full `platform-nest` suite 405 files / 5885 tests green locally (file count
reconciles with CI's red run at 404+1, proving the suite ran rather than aborting on a fast gate);
the 22 registry-touching suites green with `--no-file-parallelism`, the harshest ordering for the
pollution class that caused the failure; migration lints (names/RLS/withtenants) pass; CI green on
all nine jobs; `docs-map` green in 15 s as its own workflow.

### `Alpha 01.066.0143a` - 2026-08-23 - the estate can appoint again

Manifest (counter +1, 0142 -> 0143): `platform-nest 0.36.0 -> 0.36.1`.

Cut for one reason: since IAM-16 closed the legacy admin door, elevated appointment on production
required a pair that did not exist there (1 platform_admin, 0 owners). This ships `seed:owner-grant`
so the pair becomes satisfiable. Break-glass was never lost — seeds bypass the choke point — but the
supported path was, and that is not a state to leave an estate in.

Also carries the corrections to `0142a`'s two seeds: their headers claimed production was "clean"
and that nothing had written to `employees`. Both false, both from the same blind pre-flight query.

**Full module manifest** (rule 2):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.36.1`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.2` |
| platform-ui | `0.41.0` | ai-agents | `0.8.0` | social-media | `0.5.26` |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.11.0` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.2` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | report-renderer | `0.1.0` |
| observability | `0.6.1` | infra | `0.8.6` | mail | `0.0.19` |
| monitoring | `0.2.0` | | | | |

**Verification:** owner-grant 7/7, including the arithmetic assertion (platform_admin >= 1 AND
owner >= 1 from a fixture shaped like production) rather than just "the rows exist".

### `Alpha 01.065.0142a` - 2026-08-23 - the roster gets real access

Manifest (counter +2, 0140 -> 0142): `platform-nest 0.35.1 -> 0.36.0`,
`social-media 0.5.25 -> 0.5.26`.

The cut that makes the 19 provisioned Keycloak accounts actually usable. They have been able to
AUTHENTICATE since 0139a and to do nothing else — only 1 of 20 had a `users` row, and none had a
company membership, which is what `inTenant` is built from. This ships `seed:roster-access` and
`seed:employee-files` so that can be fixed without running the demo showcase into a clean estate.

⚠ SHIPPING THE SEEDS IS NOT RUNNING THEM. Both are opt-in scripts; the deploy only puts them on the
box. They are run deliberately afterwards, against a live estate whose state was checked first.

Also carries `social-media 0.5.26` (OAuth state bound to the principal who started it) from another
session — a tag builds `main`, so it ships whatever is on the tip, and saying so here beats leaving
it to a commit-range diff.

**Full module manifest** (rule 2 - what makes this build reconstructible):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.36.0`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.2` |
| platform-ui | `0.41.0` | ai-agents | `0.8.0` | **social-media** | **`0.5.26`** |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.11.0` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.2` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | report-renderer | `0.1.0` |
| observability | `0.6.1` | infra | `0.8.6` | mail | `0.0.19` |
| monitoring | `0.2.0` | | | | |

**Verification:** roster-access 6/6 and employee-files 6/6, each including a negative control — the
business-data tables stay empty, and the HR module wall is proven real by reading `employees` twice
and asserting the reads disagree. tsc and `lint:withtenants` clean.

### `Alpha 01.069.0145a` - 2026-08-23 - a camera, and agents that say what they are doing

Manifest (counter +1, 0144 -> 0145): `platform-ui 0.45.0 -> 0.46.0`.

**Camera on the office**: integer-step zoom (1x/2x/3x + Fit), cursor-anchored wheel, pointer and
keyboard pan, and click-to-follow that releases on any manual camera move — with a chip, a Release
button and an aria-live announcement, because releasing silently reads as a broken camera. Zoom
persists on the existing prefs cookie. Integer steps only: fractional scaling destroys pixel art.

**Emote bubbles** make the working state legible instead of a bare pulse, driven by the real event
kind from the O4 feed — thinking / working / handing over / error, and `approval_wait` as a larger,
always-opaque amber "!" that is deliberately the loudest thing on the floor. An agent blocked on a
human is exactly what should be visible across a room without hunting for it. **Humans never
emote** — guarded both in the data layer and again in the draw pass.

Adopted from `harishkotra/agent-office` as ideas only. Its UI runs Phaser + Colyseus, and it ships
no asset credits; ours stay traceable to a CREDITS.csv row apiece.

Also: the check-in line's five CSS classes had been referenced since the component shipped and
never had a rule, so the dashboard read "Not expected todayNot a working day…". And the O4 events
row finally landed in the BFF contract, which had been dirty with another session's edits.

### `Alpha 01.068.0144a` - 2026-08-23 - the spine comes out

Manifest (counter +1, 0143 -> 0144): `platform-ui 0.44.0 -> 0.45.0`.

Removes the company spine. It was a Phase 2 design bet — a tone-coded strip showing every company
at once — and the owner's first reaction to it on the live product was to ask what it was. The
sidebar already carries an explicit, labelled company switcher inches away; the spine had no label
and no affordance saying it was interactive. A control the owner has to ask about has failed.

`companyColor.ts` goes with it as dead code. It was defended on the grounds those tones also drove
row rails in cross-company tables; a grep proved that was planned, never built.

### `Alpha 01.067.0143a` - 2026-08-23 - one building, with corridors to walk down

Manifest (counter +1, 0142 -> 0143): `platform-ui 0.43.1 -> 0.44.0`.

The office was a grid of detached boxes. It is now **one connected floor**: a double-loaded
corridor spine with rooms opening onto it through real doorways, and a hand-rolled BFS that routes
a walk room -> door -> corridor -> door -> room. The corridor is topology, not decoration — the
walkable grid makes a route travel it.

- **Rooms size to headcount.** Desk columns grow 3 -> 4 -> 5 across occupancy thresholds. Vacant
  seats complete the current row instead of padding every room to three, so an empty desk still
  means an unfilled position rather than filler.
- **Floors** exist with a selector, closing a plate when the next room would overflow it, and
  assign deterministically so a department never migrates between renders. Unit-tested; the
  current roster fits one floor, so the selector is not yet exercised on screen.
- **Page-level scroll** — the nested `overflow: auto` that made the office scroll inside its own
  box is gone.
- **Working animation with a hard line under it.** Agents pulse only when their goal has a
  genuinely open run with a real event inside 45s, polled from the events endpoint shipped in
  0142a. Humans never pulse: there is no activity feed for people, and animating a colleague as
  busy would invent exactly what this feature exists not to invent. Three honest states — no run,
  open-but-quiet ("last heard Xm ago", static), genuinely active.
- Also carried: static sprite files stopped running the auth middleware, and the AGN-6 capability
  inventory was regenerated after `social.listThreadMessages` drifted the committed artifact.

Still DEMO. Movement is fixture-driven; the badge comes off when the office is driven end-to-end
by the live feed, not before.

### `Alpha 01.066.0142a` - 2026-08-23 - real people at the desks, and the wire that will make them move

Manifest (counter +1, 0141 -> 0142): `platform-ui 0.42.0 -> 0.43.0`, `platform-nest 0.36.1 -> 0.36.2`.

**The office has actual pixel-art people in it.** 24 LPC sprites (walk + sit across twelve
layers), composited body -> head -> bottom -> top -> shoes -> hair, with skin tones applied by
runtime palette swap using LPC's own ramps. Internal agents reuse the identical sprites under a
grey ramp so they read as synthetic rather than getting a second art set. Automations stay a
procedural box, deliberately — LPC ships no robot, and dressing a human sprite up as one would
misrepresent what an automation is.

**Every asset elects OGA-BY 3.0 or CC0. Zero share-alike**, so derivative sheets stay ours and no
copyleft reaches the application. Verified twice against `CREDITS.csv`, independently. The
credits page at `/office/credits` is generated by `scripts/generate-office-credits.mjs`, which
**throws if a shipped file offers neither licence** — a licence regression fails the build instead
of shipping quietly. 14 contributing artists.

**The backend half of O4.** `GET :tenantId/agents/runs/:runId/events?since=<seq>` on platform-nest,
extending the existing intelligence proxy: elevated-only, tenant-scoped, reshaped through a
whitelist. On the UI side a server-only reader and a polling route handler. Polling with a cursor
rather than chained SSE, deliberately — two SSE hops multiplies failure modes and the runner's bus
is in-process only.

`findSeqGaps`/`hasSeqGap` ship as first-class API because the emitter is fail-soft and increments
`seq` before attempting its write: a dropped event leaves a hole, and a consumer that cannot see
the hole would render an incomplete story as a complete one.

**Still DEMO.** The office does not consume the event feed yet. Plumbing existing is not the same
as the office being live, and the badge comes off only when it genuinely is.

### `Alpha 01.065.0141a` - 2026-08-23 - the half of the redesign nobody could reach

Manifest (counter +1, 0140 -> 0141): `platform-ui 0.41.0 -> 0.42.0`.

`0140a` shipped the dark-first redesign. This cut ships the ability to SEE it.

Three defects, all found by the owner opening the deployed app, and all the same
kind — the product working correctly while showing something untrue:

- **No theme toggle existed.** The only control was a `<select>` on `/account`, and the
  default is `auto`. On a light-mode machine that renders the derived light theme, which
  was deliberately built to stay close to the old linen-and-bronze identity. The owner
  judged a dark-first redesign entirely on its conservative half and reasonably concluded
  little had changed. Auto/Light/Dark now sits beside the command palette.
- **`/office` had no navigation entry** and was reachable only by typing the URL. A route
  nobody can find is a route that does not exist.
- **Estate-level agents rendered as binding failures.** Agents and automations exist from
  day one, independent of org structure; only employees arrive with departments. The code
  knew goals were tenant-wide and still filed them under "Unassigned — No department
  binding", so a company with no departments looked broken rather than new. They now live
  in a first-class Operations room.

Also in this cut: the office canvas became an actual workplace (tiled floors, walls with
doorways, nameplates, desks with chairs and monitors, labelled vacant seats, lobby chairs,
a utility rack), and the release pipeline stopped deleting the images it was about to
deploy — `0140a` failed its first deploy with `MANIFEST_UNKNOWN` because the prune step
runs inside `build-sign`, before the deploy job it feeds.

Still not shipped: real sprite art. The licence question resolved (elect OGA-BY/CC0, no
share-alike), the asset set is chosen, the wiring is next.

### `Alpha 01.064.0140a` - 2026-08-23 - the resort rename reaches the estate

Manifest (counter +1, 0139 -> 0140): `platform-nest 0.35.0 -> 0.35.1`,
**`platform-ui 0.29.1 -> 0.41.0`**.

> **Manifest corrected before this cut shipped.** As first written this entry declared
> platform-nest alone and called itself "a small, deliberate cut". That was true of its *intent*
> and no longer true of its *contents*: the platform-ui redesign (0.29.1 -> 0.40.0, then 0.41.0)
> landed on `main` first, so it is an ancestor of this release and deploys with it. The app version
> exists to answer "what is deployed, and which module set is it?" — leaving platform-ui out would
> have shipped a whole-surface UI overhaul under a note about a resort rename. Correcting the
> record rather than the history, since the release commit belongs to another session.
>
> **What rides along:** a dark-first token layer, the interactive/decorative accent split, a new
> shell with the scope bar and company spine, a hand-rolled command palette, the PM re-skin, eight
> new data primitives, an a11y and responsive sweep, and a DEMO-labelled `/office` prototype. See
> the `platform-ui 0.40.0` entry above for the full account, including the seven contrast and
> accessibility defects it uncovered.

The platform-nest half is a small, deliberate cut. `0139a` shipped IAM-15 and the corrected resort name in the SEED, but the
live estate still said `Sanur Resort` — and `seed:agency` resolves companies by name, so running it
there would have forked the resort rather than renamed it. This cut carries migration `202608230612`,
which renames in place, so the seed becomes safe to run against production for the first time since
b48df97.

**Why it is cut on its own rather than folded into the next feature release:** the 19 staff Keycloak
accounts provisioned after `0139a` can authenticate but have no ERP `users` row, and `seed:agency` is
what creates those. That seed is blocked on this migration. Cutting now unblocks the roster instead
of leaving nineteen people with half an account for another release cycle.

Also in it: the `position_roles` DELETE that ran with no tenant GUC (NOBYPASSRLS + FORCE RLS = zero
rows, reported as success), and two MAP.md regeneration fixes — generated files must come from a
clean `git worktree`, because this checkout carries fourteen untracked files that skew them, and a
three-way merge of a generated file silently drops lines.

**Full module manifest** (rule 2 - what makes this build reconstructible):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.35.1`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.2` |
| platform-ui | `0.41.0` | ai-agents | `0.8.0` | social-media | `0.5.25` |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.11.0` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.2` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | report-renderer | `0.1.0` |
| observability | `0.6.1` | infra | `0.8.6` | mail | `0.0.19` |
| monitoring | `0.2.0` | | | | |

**Verification:** the rename migration is proven against a database that ALREADY HAS the old name —
in-place (same id, children and FKs intact) and idempotent — plus holding-backbone 8/8,
`lint:migration-rls` and `lint:migration-names` clean, and `gen-map --check` clean inside a worktree.

### `Alpha 01.063.0139a` - 2026-08-23 - Phase 3 closes: the platform has one elevated tier again

Manifest (counter +13, 0126 -> 0139): `platform-nest 0.34.0 -> 0.35.0`, `platform-ui 0.29.1 ->
0.41.0` (two bumps: 0.40.0's Phase-2 shell wave, then IAM-15), `ai-agents 0.7.2 -> 0.8.0`,
`social-media 0.5.18 -> 0.5.25` (seven bumps), `reports 0.3.1 -> 0.3.2`, `search-marketing 0.5.1 ->
0.5.2`.

⚠ **THIS CUT IS MOSTLY NOT IAM-15.** Ten of the thirteen module bumps are other sessions' work that
had accumulated uncut since `0126a` — the social-media wave, SM-76's site-audit v2 + search IAM, the
platform-ui Phase-2 shell, and the reports/search bumps. A tag builds `main`, so tagging for one
ticket ships everything on the tip. Recorded here explicitly because the headline names one ticket
and the manifest names eleven, and a future reader reconstructing this build should not have to
diff the commit range to discover that.

**What IAM-15 itself changes, and it is a NARROWING:** `group_executive` (D-7) is deleted — 54
Cerbos rules across 46 policies, the derived role, its 134-key bundle, its persona, and the role row,
with a migration that revokes every grant and bumps `session_version` so live tokens cannot retain
reach. Eight production paths narrowed with it: `isElevated`, service-assignment re-consent, report
seal notifications, automation-approval deciders, the person-axis company_wide tier, the
wildcard-bypass disclosure, cross-company knowledge-graph elevation, and rollup reads. Nobody real
loses access — the estate's only holder was the `exec@gaiada.test` seed fixture.

Phase 3 is complete: IAM-13 (no-op), IAM-14 (`owner`), IAM-16 (two-person appointment) and IAM-15
have all landed. The estate now has exactly one elevated platform tier (`platform_admin`) plus
`owner` beside it on the business axis.

**Full module manifest** (rule 2 - what makes this build reconstructible):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.35.0`** | wa-chat-bot | `0.9.2` | **search-marketing** | **`0.5.2`** |
| **platform-ui** | **`0.41.0`** | **ai-agents** | **`0.8.0`** | **social-media** | **`0.5.25`** |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.11.0` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | **reports** | **`0.3.2`** |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | report-renderer | `0.1.0` |
| observability | `0.6.1` | infra | `0.8.6` | mail | `0.0.19` |
| monitoring | `0.2.0` | | | | |

**Verification this cut rests on:** the full platform-nest suite green on this exact tip — 5809
passed / 0 failed across 397 files — plus platform-ui 2705/2705, `cerbos compile` clean, and a live
PDP probe confirming `group_executive` went ALLOW -> DENY while `platform_admin` stayed ALLOW (the
control that distinguishes a working removal from a policy set that failed to load). That suite run
covers the other sessions' backend work on this tip too, which is the main reason cutting from a
shared tip is defensible here.

**Not verified by this cut:** the infra/observability changes and anything untracked at cut time
(hermes-config, mcp-hub's risk.ts) — the former ships as config, the latter is not committed and so
is not in the build at all.

### `Alpha 01.062.0126a` - 2026-08-23 - the observability split deploys, and the estate learns to page itself

Manifest (counter +7, 0119 -> 0126): `platform-nest 0.33.0 -> 0.34.0` (MSO-05), `social-media
0.5.12 -> 0.5.18` (six bumps -- SMM-16, SMM-17, SMM-22, SMM-26, SMM-35, SMM-27, each landed as its
own module version). Cut by the overnight release session on top of `alpha-01.061.0119a`'s tip,
covering the 52-commit queue CI had not yet gated as one build. Multiple migrations ship with this
cut (search-finding states, IAM-16's two-person appointment, SMM-27's best-time table among them) --
see the commit range for the full list rather than this entry, which tracks the module manifest.

**Full module manifest** (rule 2 - what makes this build reconstructible):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.34.0`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.1` |
| platform-ui | `0.29.1` | ai-agents | `0.7.2` | **social-media** | **`0.5.18`** |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.11.0` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.1` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | report-renderer | `0.1.0` |
| observability | `0.6.1` | infra | `0.8.6` | mail | `0.0.19` |
| monitoring | `0.2.0` | | | | |

**What is in it, at the infra/observability level (the reason this cut was queued):** MSO-00 (the
observability compose split stops the storage/alerting containers being resurrected on gda-aicenter
on every release), MSO-05 (the multi-host estate endpoint), MSO-06 (the fleet console rebuilt against
it), and MON-19/20 (the monitor create/update/delete + incident-ack write API). Plus IAM-16's
two-person appointment (D-9) and the SMM-16..27 social-media wave (inbox triage, reply flow, X
metering, MCP agent surface, assistant summary read, best-time-to-post).

**Not independently re-verified module-by-module by this cut** -- this entry records the manifest
per rule 2; the deploy verification (health, container diff, host-label/partition checks) is in the
infra deploy log/runbook, not repeated here.

### `Alpha 01.061.0119a` - 2026-08-21 - the company report stops repeating itself

Manifest (counter +1, 0118 -> 0119): `platform-ui 0.29.0 -> 0.29.1`. No migration.

Follow-up to 01.060, from the owner looking at the live page and saying it still read as messy and
still showed the company name twice. Both were real: the second duplication was page-title vs
sidebar (not the H1/H2 pair already fixed), and the demoted KPI tail was still rendering as fourteen
bordered cards because a one-class rule lost the cascade to the base `.rc-kpi` declared below it.

The AGN-3 manifest caveat recorded against 01.060 is now RESOLVED: that seat committed
`lib/people.ts`, so `platform-ui`'s registry lineage no longer runs ahead of its code.

### `Alpha 01.060.0118a` - 2026-08-21 - six pages that answer at a glance

Manifest (counter +2, 0116 -> 0118): `platform-ui 0.28.4 -> 0.29.0`. No migration.

**ONE LINE OF THIS MANIFEST OVERSTATES THE BUILD, knowingly.** The +2 spans two platform-ui bumps:
`0.28.4 -> 0.28.5` (AGN-3 reader-degrade, recorded in `dd89e0e`) and `0.28.5 -> 0.29.0` (this UI
work). **AGN-3's CODE IS NOT IN THIS BUILD** — `lib/readerDegrade.test.ts` and its `lib/people.ts`
change were still uncommitted in the shared checkout at cut time, verified with `git cat-file -e`
against `origin/main`. Its changelog entry therefore runs ahead of its code, and this release ships
`platform-ui 0.29.0` whose registry lineage claims work the image does not contain. Cut anyway on the
owner's explicit call, to get the report-page fixes onto the box. The repair is for the AGN-3 seat to
commit those two files, after which no further version move is needed — the number is already here.
Do not read this entry as evidence AGN-3 shipped.

Everything else here is real and measured on the live box. `01.059` carried the first half of this UI
work (`3566e2b`) without recording it — its manifest counts platform-nest and social-media only —
and that half also shipped a `.rc-kpi__foot` overflow which `a4be13d` and `d96af3e` fix. This entry
covers all three commits, so the module bump lands once, here.

### `Alpha 01.059.0116a` - 2026-08-21 - a principal discriminator, and a root boundary that holds

Manifest (counter +2, 0114 -> 0116): `platform-nest 0.32.0 -> 0.33.0`, `social-media 0.5.10 -> 0.5.11`
(landed separately). Migration: `202608201442_users_kind_discriminator.sql`.

PK-01 gives `users` a kind, so the platform can finally tell a person from a workflow in the schema
rather than by inference; PK-02 moves the people-shaped readers onto it, which un-erased every
shared-service human from the directory of the company they serve and stopped 17 n8n accounts being
listed as colleagues. Both are described in the platform-nest 0.33.0 entry above.

**The larger part of this cut is fallout repair, and it is worth recording why it was invisible.**
MON-00c root-bounded `group_executive` behind `variables.inRoot`, and `_variables.yaml` predicted the
consequence in its own comment: the `has()` guard exists because "any test fixture that constructs the
object directly has no `rootCompanies` key at all", and CEL then denies in a form that "makes every
such denial look like a policy bug". It did — **25 test files**, presenting as `expected false to be
true`, stray `403`s, and one `rows.find is not a function` where an endpoint returned an error object
instead of an array. A principal whose only grant is GLOBAL has no membership, so no root resolves.
Nineteen files re-anchored: in-memory fixtures explicitly, DB-backed suites via `home_company_id` —
never by adding a membership, which would have placed the exec INSIDE the companies whose rollups,
facts and headcounts those suites assert on, turning an authorization fix into a silent change to the
data under test.

A **second, separate** wall accounted for four more: MON-00b's `CrossRootTenantSetError` refuses a
tenant set spanning two roots, and the RLS suites created two INDEPENDENT companies and authorized
both. B became a subsidiary of A — one root, two tenants — rather than teaching ordinary
tenant-isolation fixtures to pass `{ crossRoot: { reason } }`, which would erode the thing the wall
is for. RLS is keyed on `tenant_id`, so isolation is still fully tested, and now has to hold between
companies that DO share a root.

Also fixed: `docs/MAP.md` documented UNCOMMITTED files (`import:nexus`, 128 migrations against HEAD's
127), so `--check` could never pass; regenerated from a pristine `git archive HEAD`. And
`SocialOAuthErrorFilter` was registered without updating the pin whose name is literally "adding one
must be a deliberate edit here" — the pin worked, and the edit is now recorded.

CI on `3973f3b`: the full workflow green — all ten jobs, `platform-nest` 371/373 files with 0 failed —
for the first time since `1628c60`.

### `Alpha 01.058.0114b` - 2026-08-20 - RETROACTIVE ENTRY: this shipped undocumented

Manifest: counter unchanged at 0114, no module row bumped. Tag `alpha-01.058.0114b` points at
`d59c730`, and **the live estate ran it** — so this entry exists because a deployed build must be
reconstructible from this table, not because the cut was done properly.

It was not. The VERSION bump reached `main` inside `d59c730`, a commit whose stated purpose was the
`/api/rollups` authorization fix and which staged only `core.controller.ts`. Another session had
VERSION **already staged in the shared index**, and `git commit` commits the index, not the paths you
just added. So a release was cut with no CHANGELOG entry, no `MODULES.md` bump, and `platform-nest`
still reading `0.32.0` while PK-01 and PK-02 were inside the build.

Recorded rather than quietly folded into 0116a: `alpha-01.058.0114b` exists, is pushed, and ran in
production, and pretending otherwise would break exactly the reconstructability this table promises.
Its contents are the platform-nest 0.33.0 work minus the fixture repairs — which were test-only, so
the shipped product code matches 0116a's. Verified live rather than assumed: 33 containers healthy,
all 53 users' `home_company_id` populated, and a production Cerbos probe returning own-root ALLOW /
foreign-root DENY.

### `Alpha 01.057.0114a` - 2026-08-20 - the platform can finally tell a human from their agent

Manifest (counter +3, 0111 -> 0114): `platform-nest 0.31.0 -> 0.32.0`, `mcp-hub 0.10.3 -> 0.11.0`,
`ai-agents 0.7.1 -> 0.7.2`. No migration.

[agent-attribution-gate], the interim half — and a live authorization hole that was hiding inside it.

**The hole first, because it made yesterday's release notes false.** The D14 impact gate was keyed on
`isAutomation`, which is `provider === "n8n"`. `runAgent` sends the requesting human's envelope verbatim,
so an agent-driven call never matched it: an n8n workflow calling a high-impact write suspended for
approval, and an agent calling the SAME tool ran it unattended. `0111a` shipped `iam.grantRole` (high)
on the stated basis that all four direct IAM writes suspend for a human. That was true for n8n only.
Fixed in both the in-code engine and the Cerbos policy — the latter mattering more, since Cerbos is
authoritative live. PERMISSION-CONTRACT §15 records the correction rather than quietly restating it.

**Then attribution itself:** author = the human, co-author = the agent, `actor_id` untouched. The agent
names itself from its own definition, the marker rides `x-obo-agent` through the hub's now-single
envelope builder, and `writeActivity` stamps it ambiently across all 263 call sites — because an opt-in
audit field is missing precisely where it mattered.

**Also fixed properly rather than worked around:** `REGEN-NO-DIFF` compared bytes while git's autocrlf
gave the working tree CRLF, so it could never pass on Windows. `.gitattributes` already carried
`eol=lf` for `*.sh` and `*.go`, added for exactly this class of bug; the generated rbac artifacts now
join them. Yesterday I diagnosed this correctly and then restored the file, which left the test red
forever — a diagnosis is not a fix.

### `Alpha 01.056.0111a` - 2026-08-20 - an agent can grant, and the reason it may is written down

Manifest (counter +2, 0109 -> 0111): `platform-nest 0.30.0 -> 0.31.0`, `mcp-hub 0.10.2 -> 0.10.3`.
No migration.

The owner's call on the question the last three releases kept deferring: the four direct IAM writes
become agent-reachable. What makes this cut worth reading is not the tools — they are four registry
entries and a widened allow-list — but that the reasoning is recorded at both code sites rather than
implied by the diff.

The original objection stands unrefuted: audit attribution still says "Alice", not "Alice's agent". It was
outranked by a verified fact about the data (23 employee memberships, all mock but the owner's own), and
that fact has an expiry date. Closing [agent-attribution-gate] moved from "pre-staging work" to "the
thing that must happen before a real employee account exists", and the code says so where somebody
adding the fifth tool will read it.

Also in this window, on the live estate: **P2-15's employee backfill was applied** — 23 records across two
companies, `user_roles` 53 before and 53 after in both runs, `hire_date` NULL on every row (never
invented), and zero records belonging to a bot. Verified independently of the script's own report.

### `Alpha 01.055.0109a` - 2026-08-20 - a department head can run their own department

Manifest (counter +2, 0107 -> 0109): `platform-ui 0.26.0 -> 0.27.0`, `monitoring -> 0.2.0` (another
session's catalog completion, in this cut's window — its migration
`202608191417_iam_monitoring_permissions_completion.sql` is the FIRST file to use the timestamp naming the
scheme moved to yesterday).

P2-10, P2-11 and P2-12-FE. With these every ticket in the IAM Phase 2 wave (P2-01 … P2-17) is closed;
what remains of the program is Phase 3 and full Phase 4, both scoped out of this wave by design §11.

The owner requirement that started the wave was "the department head handles permissions for their own
department". `/organization/access` is that surface, and the interesting part is not the roster — it is
that the two things a dept head is NOT allowed to do now come with the mechanism for doing them properly.
Placing someone directly is refused with `assignment_request_required`, and the UI answers with "Propose
instead". Granting above their ceiling is refused, and the UI answers with "Request override". Both were
already built server-side; until now nothing surfaced them, so the refusal was a wall rather than a door.

### `Alpha 01.054.0107a` - 2026-08-19 - IT can see who still needs a login

Manifest (counter +1, 0106 -> 0107): `platform-ui 0.25.1 -> 0.26.0`. No migration.

P2-14, the first Phase 2 UI surface. The worklist and its four actions, against P2-13's real endpoints.

Two things worth reading. The accounts reader deliberately breaks this codebase's own
degrade-to-empty-list convention, because an empty accounts list is a claim ("everyone has a login") and
not an absence of data. And wiring the tab surfaced a contradiction: the IT console's layout gated every
tool on the `it` module, which would have hidden the one endpoint specifically built to keep working when
that module is off — and hidden it behind a reassuring "module disabled" instead of "three leavers can
still log in". The gate is now per-tool.

### `Alpha 01.053.0106a` - 2026-08-19 - the phase's own acceptance criterion, proven three ways

Manifest (counter +1, 0105 -> 0106): `platform-nest 0.29.0 -> 0.30.0`. No migration.

P2-16 and P2-17. The criterion design §5.2 calls "the acceptance criterion this whole phase exists for"
is now asserted in all three operating modes — human, agent, n8n — against running Cerbos rather than
against a bundle, because a bundle cannot witness a mover at all.

The leaver case turned out to be stronger than specified and the test now says so: after terminate there
is no assemblable principal, so the probe is 401 rather than 403. "Still a principal, currently
unauthorized" is a state a leaver must not be in, and the distinction is worth pinning precisely.

Also verified against the live estate, read-only: the backfill's dry run reports 23 employees to create,
19 assignments it correctly refuses to derive, and zero automation exclusions — which is the evidence
that the bots on the box are properly kinded and the second wall never had to fire.

### `Alpha 01.052.0105a` - 2026-08-19 - the estate can be described, and IT can hand out the logins

Manifest (counter +1, 0104 -> 0105): `platform-nest 0.28.0 -> 0.29.0`. No migration.

Wave D's data half and the IT surface, both backend-only.

**P2-15** makes the Phase 2 engine describe the estate that already exists: employees from staff
memberships, assignments where they are derivable, and adoption of hand-made grants that exactly match a
seat. Adoption's rule — re-label, never create or widen — is enforced as a transaction ABORT on the
`user_roles` count, not a log line, and proven by a test that plants a row mid-transaction. The
position import is deliberately report-only forever.

**P2-13** gives IT the worklist ("who still needs a login, whose leaver login is still enabled") and the
four actions that fix it. It returns a typed 503 rather than an empty list when it cannot see Keycloak,
because an empty worklist is a claim it has no right to make while blind.

Worth recording: the backfill's first draft would have created HR records for every automation account,
because bots hold real memberships on purpose. Two walls now stand between them and the HR directory, and
the report names everything either wall excludes.

### `Alpha 01.051.0104a` - 2026-08-19 - IAM reaches the agents, and Cerbos goes back to deciding

Manifest (counter +2, 0102 -> 0104): `platform-nest 0.27.0 -> 0.28.0`, `mcp-hub 0.10.1 -> 0.10.2`.
No migration.

Two things, and the second is the one worth reading.

**Core gets a tool surface.** `positions` and `role-grants` had no module to be declared under, so the
IAM Phase 2 surface was invisible to agents. Three reads and two PROPOSAL tools now ship;
`iam.requestAssignment`/`iam.requestOverride` file a pending request a human decides. The direct
grant/assign writes are deliberately absent pending an owner decision — not for want of a D14
executor (that pattern is now worked) but because a role-granting tool is a privilege-escalation
surface and this estate's audit attribution still names the human, not their agent.

**Cerbos had silently stopped deciding which tools a caller can see.** Verifying 0102a on the box
showed `[policy] cerbos visibility check failed (cerbos 400)` in the hub's log; cerbos's own log gave
the reason: `number of resources in batch (128) exceeds configured limit (50)`. The hub asks about
every tool at once, so the check has been failing — and falling back to the in-code engine — since the
tool count crossed 50. Not fail-open (in-code is deny-by-default and mirrors the same rules) and the
per-CALL path was never affected (one resource per request), but the policy file was not the authority
it was believed to be. Fixed by chunking at 40 with fail-closed merging. Nothing detected this: the
fallback logs one warning and returns a plausible answer, which is worth remembering the next time a
"graceful degradation" path is written.

### `Alpha 01.050.0102a` - 2026-08-19 - an approved hire actually happens, and cannot happen twice

Manifest (counter +1, 0101 -> 0102): `platform-nest 0.26.0 -> 0.27.0`. No migration.

P2-07's write half, which 0.26.0 explicitly left open rather than claiming. hire/transfer/terminate are
now agent-reachable AND executable: registry entry, hub allow-list entry, tool declaration — all three,
because any two without the third fail in a different silent way.

The cut is worth reading for the defect it found rather than the feature it adds. `employees` lives
behind the HR module's RLS wall; the executor's precondition transaction had no module scope; so the
"has this person already been hired?" check would have read zero rows, found nothing, and let an
approved-then-retried hire create the same person twice. Nothing would have errored. The fix is a
declared `preconditionModules` on the registry entry, applied by the executor at both precondition
sites, with a test that asserts the BROKEN behaviour unscoped so the declaration can never be dropped
as decoration.

⚠ Not from this cut, found by its regression run and left for the owning session: `monitor`,
`monitor_channel`, `monitor_incident`, `monitor_maintenance` and `status_page` Cerbos policies landed on
main (MON-11a/b) with no `permission-catalog.json` entries, no bundle rows and no `permissions` rows —
12 red tests across 7 files in `src/rbac` (catalog count, bundle regen-no-diff, DB parity, alignment).
The parity chain this program's Phase 1 built is currently broken at HEAD for the monitoring kinds only;
nothing in `hr.*` or IAM drifted. Not fixed here because that ticket is in flight in another session and
editing its catalog under it would collide.

### `Alpha 01.049.0101a` - 2026-08-19 - the first agent-reachable slice of the people file

Manifest (counter +1, 0100 -> 0101): `platform-nest 0.25.2 -> 0.26.0`. No migration.

P2-07 in part: employee READS are now agent-reachable. The WRITES are not, and these notes say so rather
than letting "P2-07" read as finished — the write half needs a D14 executor per tool (a precondition that
re-checks staleness at execution time, a lockKey keyed on the person), or an agent's approved hire would
silently do nothing.

### `Alpha 01.048.0100a` - 2026-08-19 - one decision right becomes two

Manifest (counter +1, 0099 -> 0100): `platform-nest 0.25.1 -> 0.25.2`. Migration `0118`.

Owner instruction: split the IAM decision right so a role override and a placement request are
different permissions. Delivered with the honest caveat that nothing behaves differently today — the
same four tiers decide both — because the value is an auditable description, the ability to diverge, and
a decision row that says which kind of exception was approved.

### `Alpha 01.047.0099a` - 2026-08-19 - a dept head proposes, and a monitoring RLS gap closes

Manifest (counter +1, 0098 -> 0099): `platform-nest 0.25.0 -> 0.25.1`.

Two unrelated things, deliberately in one cut because they were found in the same regression run:

1. **The dept-head assignment flip** (§11.2's owner end-state) — a lead proposes a placement, HR or a
   company admin agrees, and the seat opens. Application-code only: no Cerbos change, no catalog
   change, no new permission.
2. **Migration `0117`** — FORCE RLS on `monitor_results` PARTITIONS. `0116` (MON-10, another session)
   hardened the partitioned parent but not its partitions, and a query naming a partition directly is
   governed by that partition's own policies. A direct read would have crossed tenants. Fixed in a new
   migration rather than by editing theirs.

⚠ Behaviour change for dept heads specifically: direct assign now returns a typed 400. Anyone building
against `POST /positions/:id/assign` should read FRONTEND-BFF-CONTRACT's new rows first.

### `Alpha 01.046.0098a` - 2026-08-19 - the routed override: a refusal with somewhere to go

Manifest (counter +1, 0097 -> 0098): `platform-nest 0.24.0 -> 0.25.0`.

Closes the last structural gap in P2-08. Before this, a dept head asking for a sensitive role got a
typed refusal naming a mechanism that did not exist. Now the same request files a routed approval, and
approving it grants — time-boxed, traceable to the approval, and decided by someone who is not the
person who asked.

⚠ Deploying this does NOT change any existing approval's behaviour: the decide route picks a Cerbos
action from the row's own origin, and every non-IAM row still takes `decide` and returns the same
shape it always did.

### `Alpha 01.045.0097a` - 2026-08-19 - the grant ceiling gets its durable mechanism

Manifest (counter +1, 0096 -> 0097): `platform-nest 0.23.2 -> 0.24.0`.

Closes the interim the owner flagged on 2026-08-18: the ceiling no longer subtracts a whole role's
bundle, it excludes per-(role, key) SELF-SCOPED pairs derived from the policies themselves. Migration
`0114` carries the marker; the baseline consideration moves to the held side rather than disappearing,
because measurement showed the marker alone would refuse every dept-head grant.

No behaviour change for any grant that worked before — the boundary is where it was, the mechanism
underneath it is the one that can tell self-service from real reach.

### `Alpha 01.044.0096a` - 2026-08-18 - fix the sweep busy-loop, and verify the reconciler live

Manifest (counter +1, 0095 -> 0096): `platform-nest 0.23.1 -> 0.23.2`.

**Why:** `0095b` made `POSITION_SYNC_ENABLED` reachable; turning it on exposed that an empty
`POSITION_DRIFT_SWEEP_INTERVAL_MS` became a 0ms sweep interval — a hot loop at ~46% CPU against
Postgres on the live box. Fixed in the app (empty/NaN/<=0 coerced to the default), in the loop (refuses
a non-positive interval), and in compose (a real default instead of an empty passthrough).

**Also in this cut:** the reconciler is now VERIFIED live, not just enabled. On the real VPS through
real SSO: a hire returned `reconciled: {granted: 1}`, and a transfer re-pointed the grant's claim from
the closed seat to the new open seat in the destination department with zero stale claims — the A2
refcount behaving as designed (same role at company scope, so the artifact is unchanged and only the
justification moves).

### `Alpha 01.043.0095b` - 2026-08-18 - the position reconciler is switchable on the live box

Manifest: **no module version moved** — this is an infra/compose change only, so per VERSIONING the
REVISION LETTER advances (`0095a` -> `0095b`) and the module-reference counter stays at `0095`.
Module set identical to `Alpha 01.042.0095a`.

**What it changes:** `POSITION_SYNC_ENABLED` and `POSITION_DRIFT_SWEEP_INTERVAL_MS` are now passed
into the `platform` container by `docker-compose.vps.yml`, and documented in
`platform-nest/.env.example`.

**Why it is its own cut:** the flag was already read by the code (P2-05 shipped it), but compose never
forwarded it — so setting it in the box `.env` did nothing. Verified on the live box before this
change: hire, transfer and terminate each returned 2xx with `reconciled: null` and zero
`user_roles.managed_by_position` rows. Seats moved; authorization did not. The capability looked
healthy while the half that matters was inert.

**Deploying this does NOT turn the reconciler on.** It makes the switch reachable. Flipping it is a
separate, deliberate act: set `POSITION_SYNC_ENABLED=1` in the box `.env` and recreate `platform`.
That changes live authorization for every position holder — grants materialise from role-sets and
closing a seat revokes what only that seat justified, with the mass-revoke brake as the backstop.

### `Alpha 01.042.0095a` - 2026-08-18 - four owner decisions, and a client over-grant closed

Manifest (counter +1, 0094 -> 0095): `platform-nest 0.23.0 -> 0.23.1`.

**Full module manifest** (rule 2 - what makes this build reconstructible):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.23.1`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.1` |
| platform-ui | `0.25.1` | ai-agents | `0.7.1` | social-media | `0.5.0` |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.10.1` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.1` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | | |
| observability | `0.6.1` | infra | `0.8.6` | | |

**Why this cut exists:** it carries an authorization NARROWING (a plain member can no longer delete
clients) and an authorization WIDENING (hr_manager can place/transfer/terminate). Both change live
behaviour, so both want their own deployable version rather than riding along in a later release.
The Cerbos policy change only takes effect once the container restarts with the new bundle — the
deploy does that, but verify it, because a healthy Cerbos has served stale policy on this estate before.

### `Alpha 01.041.0094a` - 2026-08-18 - IAM Phase 2: JML, positions, the grant surface

Manifest (counter +1, 0093 -> 0094): `platform-nest 0.22.0 -> 0.23.0`. One module bumped, so the
revision letter resets to `a`.

> **⚠ LOG GAP (noted at this cut).** Tags `alpha-01.040.0093a`, `alpha-01.040.0093b` and
> `alpha-01.040.0093c` exist in git with **no entry in this table** — the same rule-2 skip the
> 2026-08-04 note above records. Not back-filled here (this session does not know what those three
> cuts contained beyond `platform-nest 0.22.0`); whoever cut them should add them. The
> **App version** line in `MODULES.md` was also stale at `01.029.0074a` — twelve releases behind —
> and is corrected at this cut, per VERSIONING rule 5 (`/VERSION` is authoritative).

**Full module manifest** (rule 2 - what makes this build reconstructible):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| **platform-nest** | **`0.23.0`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.1` |
| platform-ui | `0.25.1` | ai-agents | `0.7.1` | social-media | `0.5.0` |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.10.1` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.1` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | | |
| observability | `0.6.1` | infra | `0.8.6` | | |

**What is in it:** the IAM Phase-2 capability wave — `POST /hr/employees` + `transfer` + `terminate`
(P2-06), positions CRUD and the role-set composer (P2-12 backend), the `role_grant` grant/revoke
surface (P2-08 part A), and the expiry + drift sweeps (P2-09), plus migration `0111`. The §5.2 mover
criterion is proven against running Cerbos. Expiry is now enforced at resolution time as well as
swept.

**What is deliberately NOT in it:** the routed override (`decide_override` does not exist), MCP tools
for any Phase-2 capability (so none of them meet the agentic-native bar yet), future-dated JML, and
every UI surface. `POSITION_SYNC_ENABLED` remains **off** by default, so the reconciler ships dark;
the grant surface and the expiry sweep are NOT behind that flag and are live on deploy.

**Two owner decisions ride with it:** the ceiling's new baseline subtraction needs ratification
(`PERMISSION-CONTRACT` §12.1), and HR's lack of `position.assign` reach needs a ruling (§11.2).

### `Alpha 01.039.0092a` - 2026-08-13 - the social module gets a surface, and a composer

Manifest (counter +3, 0089 -> 0092): `social-media 0.2.0` then `0.3.0` (two bumps), and
`platform-nest 0.21.3`. The counter counts BUMPS, not modules — SMM-02 and SMM-08 landed as
separate module versions, so they advance it twice.

**Full module manifest** (rule 2 - what makes this build reconstructible):

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| platform-nest | **`0.21.3`** | wa-chat-bot | `0.9.2` | search-marketing | `0.5.1` |
| platform-ui | `0.25.1` | ai-agents | `0.7.1` | **social-media** | **`0.2.0`** |
| ai-gateway-go | `0.13.2` | hermes-gateway | `0.2.0` | creative | `0.1.0` |
| mcp-hub | `0.10.1` | capture-helper | `0.2.0` | render-gateway-go | `0.0.0` |
| sync-engine-go | `0.7.0` | webdev | `0.13.0` | reports | `0.3.1` |
| automation (n8n) | `0.4.1` | webdesk | `0.0.0` | report-renderer | `0.1.0` |
| observability | `0.6.1` | infra | `0.8.6` | mail | `0.0.19` |

**What is in it.**

- **SMM-08** - the composer backend: posts + per-network variants, the media-rule/quota validation
  engine, `args_sha256` (the estate's canonical hash, vector-pinned against the MCP hub), and the
  native-import path. Edit-invalidates-approval is mechanical, not policy.
- **SMM-02** - the `social` module registers and serves `/api/:tenantId/modules/social`:
  engagements CRUD, the tool-scope dial on its own endpoint and its own permission, brand profiles,
  campaigns, KPI targets, six rollup metrics, four MCP tools. The first department built TO the
  agentic-native bar rather than retrofitted onto it, which the plan named it as the last one that
  could be. No publish path yet - that is SMM-04 (Postiz containment) and SMM-05 onward, and the
  publish/inbox/report/ledger tools are deliberately undeclared until their endpoints exist.
- **HIER-5/TRAP-4** (concurrent session) - `group_executive` was folded into an `inTenant` gate on
  five kinds, where it can never match, so the cross-company oversight tier was denied on exactly
  the kinds it exists to oversee. Split into its own `notLow`-only rule. Repairs a dead grant;
  does not widen the role.

**Migration impact: NONE.** No new migrations - `0105`/`0106` shipped in `0089a` and are already
applied on the box. Code and docs only.

**Access impact: NONE by design, one dead grant repaired.** SMM-02 declares five permission keys
`0106` already seeded, and the module stays dark for every company without `social` in
`enabled_modules` or an active `service_assignment` - none has either. The TRAP-4 split changes no
role bundle (the generator treats resource-instance conditions as satisfied, so computed coverage is
byte-identical); what changes is that a `group_executive` holder's grant now actually fires at
request time on those five kinds.

> **LOG GAP, noted 2026-08-12.** `01.036.0086a`, `01.037.0087a` and `01.038.0089a` were cut with no
> entry here - rule 2 skipped three times running, the same failure this file already records for
> `0028a`/`0030a`/`0031a`. Not back-filled by this session: each manifest IS recoverable
> (`git show <tag>:docs/modules/MODULES.md` is authoritative for that tag), but the narrative of what
> those releases were for belongs to whoever cut them. The manifest half is a two-minute job, and it
> is the half that makes a deployed build reconstructible.

### `Alpha 01.035.0084a` - 2026-08-10 - one project-management interface, everywhere

Manifest (counter +1, 0083 -> 0084): `platform-ui 0.25.0`.

The owner found three surfaces showing the same data with different names, different
tabs and different filters. They are now one interface: `Overview` (was Board),
`Ball`, `Timeline` (was Gantt), `Charts`, `Productivity` — on /pm, on the new Business
`/project-management`, in every department console, and in the single-project
workspace. "PM" and the vague "Work" tab are gone; everything is called Project
Management. Names are single-sourced through `PM_TERMS`, so the next rename has one
place to change rather than four to miss.

Ball is its own tab on EVERY surface and no longer a Board swimlane. Business collapses
to one sidebar entry with Projects/Tasks as tabs instead of separate rows.

THE TIMELINE WAS NEVER THE GANTT'S FAULT. It already had scroll and Day/Week/Month
zoom; the constraint was `shell.css`'s `.erp-main__inner { max-width: 1180px }` capping
every page regardless of content shape. Fixed with a `:has()` widen rule — the same
idiom that file already uses — rather than by inflating numbers inside the chart.

Filters: active selections are now removable chips with Clear all, above a collapsible
picklist. Native HTML, no client JS, no dependency.

Deep links: none broken, none redirected. /pm, /projects, /tasks and ?view= all resolve
as before. Business points at /project-management rather than a query-param on /pm so it
cannot inherit a stale scope cookie.

### `Alpha 01.034.0083a` - 2026-08-10 - the mirror stops drifting from the authority

Manifest (counter +1, 0082 -> 0083): `platform-ui 0.24.0`.

Owner's question: does the superadmin actually have everything? Answer: yes today —
all 31 capabilities were in the hand-written `ALL` array — but NOTHING KEPT IT TRUE.
`can()` has no superadmin bypass; it tests membership of that array. Now `Capability`
and `ALL` both derive from one `CAPABILITIES` tuple, so a new capability is the
owner's automatically, pinned by a test that loops the tuple rather than a second list.

TWO ROLES WERE MISSING FROM THE MIRROR ENTIRELY. `team_lead` (granted PM parity with
manager, dept-lead report reads, and the appraisal tier across ~27 policies) and
`viewer` (granted `pm_task:update`) held ZERO capability in the UI — features silently
absent for anyone in those tiers. `manager` was also missing `company.manage`, which
hid the connections seat-mapping admin from every manager.

The new parity test parses `derived_roles.yaml`'s own `g.role == "xxx"` comparisons and
asserts each exists in ROLE_CAPS. **It failed on `viewer` before the fix** — it caught an
omission nobody had reported, which is the only proof a drift test is worth having.

Judgement calls, stated not buried: `people.directory` for team_lead (no Cerbos resource
models directory browsing; granted on `resource_member.yaml`'s baseline read) and
`company.manage` for manager (widens a few company_admin-only buttons to a clean 403 —
the safe direction, since the server remains the authority).

### `Alpha 01.033.0082a` - 2026-08-09 - the ball was open; the UI said it wasn't

Manifest (counter +1, 0081 -> 0082): `platform-ui 0.23.3`.

The Ball tab borrowed Board's `canEdit` (`pm.manage`) to drive its empty state, so a
plain member — who genuinely holds `pm.contribute` — was told "you can't move cards
here." The server had already been opened to them: `resource_pm_task.yaml` grants
`update` to any member and reserves `manage` for leads/admins, and `patchTask`
escalates to `manage` only when an assignee write is NOT a pure ball pass. The write
path in `pmActions.ts` was already correct. Only the message was wrong — which is
enough to suppress an affordance nobody then tries.

Now a named `BALL_GATE_CAPABILITY`, a separate `canPassBall`, and copy that states
the real requirement. Board/Gantt keep `canEdit`: their writes genuinely are
`pm.manage`. Pinned by a test that asserts the capability CONSTANT and cross-checks
the page and the action agree — a test that only proved a button renders would pass
again the day the two drift apart.

REPORTED, NOT FIXED: `lib/rbac.ts` has no `team_lead` role at all, while Cerbos grants
`team_lead` update+manage on PM. A team-scoped lead gets zero PM capability in the UI
mirror. That is a missing role tier, not a ball bug — architect call.

### `Alpha 01.032.0081a` - 2026-08-09 - the ball gets its own tab

Manifest (counter +1, 0080 -> 0081): `platform-ui 0.23.2`.

Owner report: the ball cluttered the board. It was Board's fourth "Group by"
swimlane, turning the whole board into ball-holder columns. It is now a peer tab —
Board / Ball / Gantt / Charts / Productivity — and the swimlane option is gone from
Board's dropdown.

A move, not a redesign: same filters, same empty state, same canEdit note, same
`reassignBall` write path (pm.contribute) that commit 6b2154d made real. The ball
FILTER facet stays in Board deliberately — a filter is not the surface that cluttered.

A stale `?view=board&swimlane=ball` bookmark degrades to the status default instead
of rendering a branch that no longer exists. Tab anchors gained `aria-current`,
which they were missing.

### `Alpha 01.031.0080a` - 2026-08-09 - the list that forgot six columns

Manifest (counter +2, 0078 -> 0080): `platform-nest 0.20.1`, `platform-ui 0.23.1`.

**HOTFIX — every page rendering a PM card threw.** `TypeError: Cannot read properties
of undefined (reading 'length')` at `Board.tsx`'s subtask counter, caught by the error
boundary, on My Work / boards / departments / tasks / calendar / Gantt.

Root cause: the tenant-wide paginated task list (`GET /api/:t/pm/tasks`, added
2026-08-07) carries its OWN hand-written CTE instead of the shared `TASK_SELECT`, and
that projection never selected `t.subtasks` - nor `description`, `estimate_minutes`,
`custom_fields`, `recurrence`, `loggedMinutes`, `contributors`. Six frontend call sites
funnel through that one endpoint, so every card built from it arrived with
`subtasks: undefined`.

Why no gate caught it: `lib/pm.ts` declares `subtasks: Subtask[]` REQUIRED, so TypeScript
treated "always present" as proven. A type that overstates a guarantee does not merely
fail to catch this class of bug - it suppresses the checks that would.

Fixed at three layers, deliberately: the CTE now matches `TASK_SELECT` (the real defect);
`normalizePmTask` guarantees the shape at the platform-ui boundary regardless of which
endpoint answered (so the next hand-written query that drifts cannot blank the app); and
the render site short-circuits on an absent array.

The regression test asserts CONTENT, not key-presence, and was proven by reverting the SQL
fix and watching it fail. That is the difference between a test and a decoration.

### `Alpha 01.030.0078a` - 2026-08-09 - the provisioning seam is in place and gated

Manifest (counter +4, 0074 → 0078): `platform-nest 0.20.0`, `platform-ui 0.23.0`, `mcp-hub 0.10.1`, `webdev 0.13.0`.

**The site provisioning seam (PRV-00..04).** Idempotent provisioning of GitHub repos + vhosts: `POST /api/:t/modules/webdev/provision` creates a mirror row, spawns egress in one transaction, and returns immediately (polling is detached); `GET /provisioned-sites[?runId=]` and `GET /provisioned-sites/:id` read back the state; `POST /provisioned-sites/:id/reconcile` re-drives the poller. Migration `0090` adds the `webdev_provisioned_sites` table (THIRD-WALL RLS, three partial uniques for idempotency). `ProvisionProvider` driver interface + `provision-http` driver + the `webdev.provisionSite` MCP tool. Cerbos policy + D14 executable-registry entry gate the endpoints (PRV-03) — until the policy exists, all calls 403 (correct fail-closed for infrastructure creation). **PROTOTYPED:** verified against the in-process PRV-00 mock; DEV-VERIFIED claim belongs to PRV-07's live leg on the boxes after this deploys.

**The Site & repo card and print fix.** `(app)/pipeline/[runId]` gained a "Site & repo" card showing provisioning status + link to the provisioned site. Print/PDF export no longer overlaps the provenance banner on page 2 onward (`position: fixed` repeats on every page, but CSS `padding-top` applies only once; banner is now in-flow).

**MCP Hub exposes provision.** `webdev.provisionSite` added to the `wf:delivery` allowlist so automation can provision sites under approvals suspension.

### `Alpha 01.029.0074a` - 2026-08-08 - the follow-ups the last cut owed

Manifest: `platform-nest 0.19.0`, `platform-ui 0.22.0` (counter +2, 0072 -> 0074). The bookkeeping
caveat from `0072a` still stands and is still not this session's to close: the concurrent PM work in
`ai-agents`/`mcp-hub`/`wa-chat-bot` remains unbumped.

**A sign-in link no longer looks broken in the preview.** MAIL-38 rendered `<a href=""></a>` for
auth-stream mail, which reads as a broken template on the exact surface built for reviewing mail
quality. It is the opposite: the magic-link URL carries a bearer token and is **deliberately never
stored** (verified live - auth rows hold only `ttlMinutes`, 0 of 7 carry an `href`), so the preview
genuinely cannot reproduce it. The endpoint now returns `linkOmitted` and the panel explains it in a
sentence. Found by driving MAIL-38 end to end rather than trusting that a 401 on the route meant the
feature worked.

**`escapeHtml()` now scheme-allowlists `href`.** Escaping is not scheme-safety: a `javascript:` URL
contains no `<`, `>`, `"` or `'`, so it passed through untouched into `<a href="...">`. Not
exploitable when found - every writer prefixes the trusted `MAIL_LINK_BASE_URL` - but MAIL-38 now
renders these templates onto an elevated-only admin page, so the renderer holds on its own instead of
inheriting safety from every caller. Allowlist (`https?://` after stripping C0 controls, defeating
`java
script:`), never a denylist; a refused URL renders as a dead link with the value still visible.
Tests proven to have teeth by defeating the fix and confirming they fail.

**MAIL-05's outer controller is now DRIVEN, not corroborated** - a caveat carried since B2. The real
`POST /:tenantId/pipeline/gates` was called over authenticated HTTP and produced a `sent` row tied to
that gate id, carrying a portal-prefixed link with no token or action params, so M11 holds on a live
row. The trap worth keeping: the first attempt used `actorSide: "internal"`, produced no mail and
looked like a defect - it is not, because `openGate` resolves recipients only for client-actionable
gates (staff notifications are realtime in-app by design), and a stale row from an earlier probe sat
at the top of the table and was nearly accepted as proof. **Query by the id you just created, never
`ORDER BY created_at DESC`.**

### `Alpha 01.028.0072a` - 2026-08-08 - the mail dev stage, and the bug its own exit gate found

Manifest bumped by this cut: `platform-nest 0.18.0`, `platform-ui 0.21.0` (module-reference counter
+2). **Bookkeeping caveat, recorded rather than papered over:** this build also carries a large body
of concurrent PM work - roughly 14.5k insertions across `ai-agents`, `mcp-hub`, `wa-chat-bot` and the
PM areas of `platform-nest`/`platform-ui` - that landed on `main` with **no module version bumps**.
Those three modules are therefore NOT bumped here and this manifest understates what actually ships.
Not back-filled: the session that wrote that code should record it, and inventing changelog text for
14.5k lines nobody in this session reviewed would be worse than naming the gap. Same class as the
LOG GAP note above.

**A forged bounce could lock someone out of their own account.** The mail subsystem's own adversarial
exit gate (MAIL-18) found it live, which is the entire reason that gate exists. `intake.ts` suppressed
on stream `'*'`, and `isSuppressed` matches `stream IN ($2,'*')` - so one inbound message permanently
cut an address off from every stream, **including the auth stream that carries sign-in mail**. The
victim loses their mail and the recovery path for losing their mail at the same moment.

It is a vulnerability rather than a strict default because `classifyNdr()`'s "two independent signals"
are not independent *of the attacker*: From, Content-Type, Auto-Submitted, Subject and the RFC-3464
body fields are all read out of the untrusted message. `ndr.ts` calls the body fields "the part a
hand-written fake would have to forge" - forging them is a few lines of text. The only real barrier
was holding one reply token, and reply tokens ship in the `Reply-To` of every threads-eligible mail
the victim receives. Now: suppression is scoped to the token's own stream, never `'*'`, and inbound
content can never suppress the auth stream at all. The row still flips to `bounced`, so a genuine
bounce stays visible - what is withheld is the destructive side effect, not the signal.
**Deliberately incomplete:** a notify-stream token can still suppress notify mail. Closing that needs
corroboration the sender does not control (a provider-side bounce event), which does not exist until
staging wires a real provider - carried to the staging register under R3/R4, and it must close BEFORE
the real inbound webhook goes live, because at that point the token wall disappears.

**You can finally read a sent email inside the ERP (MAIL-38).** `/admin/mail` listed every message and
could not open one, because `mail_log` stores `template_key` + `payload` and never the composed body -
so no page could render it and the only surface that could was a dev sink reachable over an SSH
tunnel. A new elevated-only `GET /api/admin/mail/log/:id/preview` recomposes it on demand through the
same `renderTemplate()` the sender uses, caching nothing. Rendered in a `sandbox=""` iframe: the
templates already escape payload values, but payload can carry inbound-derived text and MAIL-18 only
proved those bytes inert *as stored*, which is not the same as inert once composed into HTML on an
admin page.

**Two verification tools were manufacturing false failures.** Neither was a product defect and both
cost a full QA run. `replay-inbound.mjs` never set `app.mail_context`, so under MAIL-22's FORCE RLS
its own DB check read zero rows and printed "THREADING NOT VERIFIED" for replays that had threaded
perfectly. `scripts/sso-login.sh` emitted the token with a trailing `
` on Windows, so every
`Authorization: Bearer <token>
` was malformed and rejected *below* Fastify's request logger - a bare
400 with **no log line**, which reads exactly like an outage and was reported as one. Its `--only`
flag also accepted a single filename by strict equality, so a comma list replayed zero fixtures and
exited green. All three failed the same way: **a check that can silently measure nothing and call it
success** - the recurring failure mode of this whole program.

**Also:** nginx now routes `/api/mail/` (NET-01), so the inbound webhooks reach the app at all - they
had been 307ing into platform-ui since they were written. Rate-limited at the edge, verified live
(40 rapid posts -> 15 pass, 25 x 429). The BFF contract's "mail_log has no RLS" line is corrected;
reading it literally is what set the RLS trap above.

### `Alpha 01.027.0070a` - 2026-08-07 - the four things the owner found by using it

Everything in this cut traces to the owner driving the deployed assistant and reporting what they saw.
No test produced any of it.

**A handoff filed a write behind your back.** Not merely "skipped the confirm chip" - it filed into
`automation_approvals` and notified every decider the moment the goal suspended. Closed by reusing the
chat path's exact mechanism, so the safety property no longer depends on how a run was started.

**Threads all read "New chat".** The client-side fix shipped in `0063a` could never have worked for
them: it fired only on a thread's FIRST message, and every existing thread already had messages. It was
also client-side, so only one UI path titled anything. Now written server-side in the same transaction
as the first message insert, plus a backfill proven against a NON-SUPERUSER `NOBYPASSRLS` role - the
real deployment shape, where a missing GUC matches zero rows and reports success. 4 untitled -> 1, and
that one correctly stays "New chat" because it has no user message.

**A model's invented tool name is now resolved, not just survived.** Two hand-written aliases, reads
only, enforced at module load, resolved before any authorization gate.

**Accessibility got a real gate and an honest boundary.** 15 axe checks across 7 surfaces x both
themes, which found six places rendering informational text with the DECORATIVE `--ink-faint` token.
Deferred items carry rule ids and reasons rather than blanket suppressions. No screen reader has been
run - `docs/a11y-manual-checklist.md` is the 15-minute human pass for what axe structurally cannot see.

Counter `0067 -> 0070`: three module rows (platform-nest, ai-agents, and platform-ui from a concurrent
session's collapsible sidebar).

**Known gaps, stated rather than implied closed:** no real screen-reader pass; a harvested handoff
intent may not surface in an already-open thread until reload; and the write path's live behaviour is
still unconfirmed end to end - an earlier "verified" claim was true of the configuration and false of
the behaviour, because `/complete` was discarding the provider hint while D13 moved to enforce on the
provider that actually served.

**Module manifest** (VERSIONING rule 2):

| Module | Ver | | Module | Ver |
|---|---|---|---|---|
| platform-nest | `0.17.0` | | webdev | `0.11.0` |
| platform-ui | `0.20.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.2` | | search-marketing | `0.5.1` |
| mcp-hub | `0.10.0` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| automation (n8n) | `0.4.1` | | render-gateway-go | `0.0.0` |
| observability | `0.6.1` | | reports | `0.3.1` |
| infra | `0.8.6` | | report-renderer | `0.1.0` |
| wa-chat-bot | `0.9.2` | | mail | `0.0.19` |
| ai-agents | `0.7.1` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

### `Alpha 01.026.0067a` — 2026-08-07 — the agent runner can finally obtain the provider it declares

The last link in the D13 chain. `0065a` made D13 enforce the provider that actually SERVED and made
Ollama Cloud selectable; this makes the runner able to GET it.

- **`ai-gateway-go` `0.13.2`** — `/complete` now honours the `provider` hint, like `/complete/stream`
  always did. Until this, ai-agents' runner (which calls `/complete`) could ask for its eval-cleared
  provider and be silently ignored, so agent writes were contained-but-inert rather than working. Found
  by probing the box: the same hint returned `hermes` on `/complete` and `openai` on `/complete/stream`.
- **`platform-ui` `0.19.1`** and the assistant server-side titling / a11y-audit work from other sessions.

**End state on `gda-aicenter`, verified rather than assumed:** unhinted text → `hermes` (wa-chat-bot,
knowledge and search unchanged); `hint=openai` → `openai / deepseek-v4-flash` on BOTH endpoints; `/media`
on a real image → a genuine vision description; the assistant's picker lists **"Ollama Cloud"** and the
choice persists to `assistant_threads.brain_provider`.

Two traps recorded in the box's own `.env` because each cost a wrong conclusion: a **1×1 test PNG** makes
`/media` look broken (the vision model rejects it, the chain fails over, and you get the echo stub —
indistinguishable from "unconfigured"), and picking a brain **within milliseconds of "+ NEW CHAT"** races
the router push that adds `?thread=`, remounting the controlled `<select>` so the change is discarded with
no request sent. A human is too slow to hit the second; automation hits it every time.

Counter `0065 → 0067`: two module rows (ai-gateway-go, platform-ui).

### `Alpha 01.025.0065a` — 2026-08-07 — D13 stops trusting a declaration it could not verify,
and the provider that makes it true becomes selectable

> Cut as `0064a` first and re-cut before tagging, so `0064a` **never existed as a tag or a
> deployment** — it was absorbed here rather than superseded. The reason is worth keeping: the
> D13 fix alone would have left agent writes CONTAINED on the box with no way to enable them
> honestly, so shipping the enforcement without the eval-cleared provider it demands would have
> been a half-measure dressed as a release. Two module rows, one coherent change.

One module moved, and it closes a security control that had been passing on a false premise since the
agent-write path shipped.

**`ai-agents` `0.7.0` — D13 enforced a DECLARATION, and on this box the declaration was untrue.**
`runWriteAgent` checked `AGENT_SERVING_PROVIDER` (compose default `openai`) against
`def.evaledProviders`. But `openai` cannot serve on `gda-aicenter` at all — no `OPENAI_BASE_URL`/
`OPENAI_API_KEY` (⇒ `Available()=false`), absent from `LLM_CHAIN`, and site topology strips
gemini/claude anyway — so the effective chain is `[hermes, central-forward, echo]` and **Hermes authored
every agent write while the gate believed the eval-cleared `openai` had.** D13's promise is *"only a
provider that passed its eval suite may author a write"*; a control an env var can satisfy on its own is
not that promise.

Fixed as a class, in two halves that only work together:
1. **Enforce what SERVED** (`deps.lastProvider()`); the declaration is demoted to the cold-start seed.
   This closes the wire `runWriteAgent`'s own docstring already called *"the one remaining runtime
   wire"* — completing stated design intent, not reversing `79051ff`'s pin. Prefer-observed rather than
   replace-declared, because an UNSET declaration was itself a real failure mode (writes go silently
   inert) and `lastProvider()` is undefined until the Gateway has served once.
2. **Ask for it** — the declaration now rides as the Gateway's per-request `provider` hint
   (`chain.RunWithHint`, the brain picker's wire). Before this it asserted a provider without ever
   requesting one, so it could never come true. Now the runner asks and (1) verifies it got it.

**`platform-ui` `0.19.0` — the brain picker offers "Ollama Cloud".** The OpenAI-compatible slot was
configured-but-unreachable from the UI, and it is the ONE provider `task-filer`'s eval was run against.
The labels now distinguish the LOCAL ollama daemon from the cloud slot (same brand, different runtime and
cost), and 4 tests pin every picker value against `ai-gateway-go`'s `knownProviders` — because a wrong
value fails silently: it degrades to "Auto" with no error anywhere.

**Enabled on `gda-aicenter` at the same time** (`.env`, no code): `OPENAI_BASE_URL`/`OPENAI_API_KEY` →
Ollama Cloud, and `openai` appended **LAST** to `LLM_CHAIN`. Appending last is the whole trick — site
topology strips gemini/claude, so unhinted callers (wa-chat-bot, knowledge, search) keep getting hermes
first, unchanged; only a caller that HINTS openai gets it (the agent runner, or a user picking "Ollama
Cloud"). `OPENAI_MAX_TOKENS` raised to 4096 because `deepseek-v4-flash` is a REASONING model: reasoning
shares the budget and the provider returns a present-but-empty `content` as legitimate, so a starved
budget reads as a silent empty reply rather than an error.

**The `mcp__gaiada__*` tool names in `0063a` were Hermes' fingerprint, not a model guessing.** That cut
recorded `task-filer` calling `mcp__gaiada__pm_listTasks` and read it as cross-namespace inference. A
live probe of the same box returned `mcp__gaiada__projects_list` **from Hermes** — so the invented names
were evidence that the un-evaled provider was authoring turns in production. `ff0a061` made that symptom
non-fatal; this makes the cause impossible. Both were right to land.

⚠ **DEPLOYMENT CONSEQUENCE, deliberately not papered over: agent writes are now CONTAINED on this box**
(loudly, with `declared "openai", Gateway served "hermes"` in the reason) instead of executing via an
un-evaled model. That is the correct state — the previous green was false. Enabling the feature honestly
needs an eval-cleared provider to actually serve. The clean one-step option is to append `openai` **LAST**
to `LLM_CHAIN` and point `OPENAI_*` at Ollama Cloud: appending last changes nothing for unhinted callers
(site mode already leaves hermes first for bot/knowledge/search), the runner's new hint promotes it for
itself only, and `openai` is the provider `task-filer`'s eval was actually run against, so the existing
evidence stays valid. NOT done here — CLAUDE.md states Ollama Cloud is shared + weekly-rate-limited and
must not become a hard prod dependency, so that is an owner decision. If it rate-limits, D13 now fails
closed rather than misbehaving. **Enrolling Hermes instead is not available:** it holds the runner's JSON
protocol but names tools in its own MCP namespace, so every call fails the allow-list.

Counter `0063 → 0065`: two module rows moved (ai-agents, platform-ui). Note `cd2a13f` (observability OBS-04) and `2b03126`
(nginx NET-01) shipped in this cut **without** bumping their module versions, so the counter understates
the churn — flagged rather than silently corrected, since those are the owning sessions' entries.

**Module manifest** (VERSIONING rule 2):

| Module | Ver | | Module | Ver |
|---|---|---|---|---|
| platform-nest | `0.16.0` | | webdev | `0.11.0` |
| platform-ui | `0.19.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.1` | | search-marketing | `0.5.1` |
| mcp-hub | `0.10.0` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| automation (n8n) | `0.4.1` | | render-gateway-go | `0.0.0` |
| observability | `0.6.1` | | reports | `0.3.1` |
| infra | `0.8.6` | | report-renderer | `0.1.0` |
| wa-chat-bot | `0.9.2` | | mail | `0.0.19` |
| ai-agents | `0.7.0` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

### `Alpha 01.024.0063a` - 2026-08-07 - what the first live drive of the assistant found

Cut immediately after the owner used `0061a` on the real box. Two defects, both found by a
human sending one message - neither by any test we wrote.

**A hallucinated tool name killed the whole turn.** Asked to create a task, the model called
`mcp__gaiada__pm_listTasks`, which exists nowhere, and the turn died with "Assistant reply failed".
Our own design invited the guess: `task-filer` holds writes under `pm.*` and reads under
`tasks.*`/`projects.*`, so a model seeing `pm.createTask` infers `pm.listTasks`. Refusing the CALL
was right; ending the TURN was not. An off-list name is now fed back as a typed refusal naming the
exact allow-listed tools, bounded at 2 attempts, after which behaviour is exactly as before. The
tool is still never invoked, and a real write still suspends.

**Why every test missed it, which is the part worth keeping:** VER-ASST23 and T5 both drove the
loop across real OS processes - but with SCRIPTED tool calls that always used valid names. Nothing
asked what happens when the model picks a name that does not exist, which is the single most likely
thing a real LLM does. Cross-process verification is not real-input verification.

**The chat opened onto a debug panel.** A new thread rendered the full raw tool catalogue -
`activity.feed`, `authz.check`, `workActivity.relink` - with developer prose. It now leads with four
human-readable tiles and the catalogue moved behind the existing CAPABILITIES button: relocated for
power users, not deleted. Suggestions fill the composer and never auto-send, because auto-sending
would spend a provider call on a guess at intent. Threads also auto-title from their first message
(the sidebar was a column of identical "New chat" rows), and the rail collapses, persisted through
the existing `gaiada_prefs` cookie with a type-guarded parse so an older cookie cannot break the page.

Counter `0061 -> 0063`: two module rows (ai-agents, platform-ui).

**Known gaps, not implied closed:** no real screen-reader pass; the naming inconsistency between
`pm.*` writes and `tasks.*` reads is recorded as a design wart rather than fixed, because those names
are load-bearing across D14, the executable registry, `wf:report`'s allowlist and the Cerbos policy
list; and a handoff to `task-filer` still files without the in-thread confirm chip.

**Module manifest** (VERSIONING rule 2):

| Module | Ver | | Module | Ver |
|---|---|---|---|---|
| platform-nest | `0.16.0` | | webdev | `0.11.0` |
| platform-ui | `0.19.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.1` | | search-marketing | `0.5.1` |
| mcp-hub | `0.10.0` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| automation (n8n) | `0.4.1` | | render-gateway-go | `0.0.0` |
| observability | `0.6.1` | | reports | `0.3.1` |
| infra | `0.8.6` | | report-renderer | `0.1.0` |
| wa-chat-bot | `0.9.2` | | mail | `0.0.19` |
| ai-agents | `0.6.1` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

### `Alpha 01.023.0061a` — 2026-08-06 — the assistant can propose a write, and you confirm it in-thread

ASST-23. When this release's work started the assistant could not propose a write **at all**, blocked
three independent ways: the broker's tool universe was read-only, the only write-capable AgentDef was
unreachable through it, and `RERUN_CAPABLE_HIGH_WRITES` was `[]`. All three are closed, and
`pm.createTask` + `pm.createDoc` are now proposable — the owner chose both for v1.

**The owner overrode the architect** on one point, and it is recorded that way deliberately: an
in-thread **confirm chip** is required before anything is filed. The architect argued against it (the
approval is already the human gate, so you confirm twice for one write); the decision stands and both
sides stay legible in `2026-08-06-asst-23-unblock-design.md` §2.4.2/§7.

**The architectural correction that made this cheap:** `mcp-hub`'s impact gate is **automation-only**
and is not on the assistant's path. The mechanism is the *agent-side* write gate, which fires on the
AgentDef's **declared** impact, and D14-12's stricter-wins rule preserves a declaration stricter than
the registry. So: no new hub tool, no re-tiering, no Cerbos rule change, no mcp-hub edit. Re-tiering the
PM tools would have started suspending the WD-06 report pipeline — a working program broken to enable a
new one.

**Three real bugs found by building it, none of which a green suite would have shown:**
- `write-agent.ts` filed the literal `"high_write"` while every consumer accepts only
  `medium|high|unclassified` — **the first genuine high_write filing in the platform's history would
  have 400'd.** It survived because every agent-side test scripted `callTool` and D14-17's tests used
  raw SQL: two independent test strategies each bypassing the one contract that mattered.
- The confirm design's own claim UPDATE both nulled `tool_args` and `RETURNING`ed them — which returns
  NULL, so the confirm would have filed an approval with **no arguments**. Caught by an implementer
  contradicting the spec.
- `loadThread` had no staleness guard, so a slow thread fetch could resolve after you switched threads
  and overwrite the new thread's messages. Found by writing the browser spec.

**Verified across real OS processes** (VER-ASST23), not against a double: propose → confirm → approve →
execute → notify, with a real `pm_tasks` row, `requested_by = executed_by ≠ decided_by` in one query,
and `SuspendedIntent.impact` observed crossing as the wire label `"high"` — the exact seam the first bug
above existed for.

Also in this cut: `AGENT_SERVING_PROVIDER` pinned (unset, D13 strips the write tools and the assistant
goes **silently** read-only while every local test passes), and CI's Cerbos pinned to `0.54.0` to match
compose — the authz engine had been pinned in production and floating in the pipeline.

Counter `0056 → 0061`: five module rows moved (platform-nest, platform-ui, ai-agents, infra, and mail
from a concurrent session). **Not included:** the PM Phase 4 session's 15 uncommitted files — another
session's in-flight work is not mine to land, and committing it would risk turning `main` red on code
whose tests I cannot vouch for.

**Known gaps, not implied closed:** no real screen-reader pass; the new Playwright spec is in the
`chromium` project so it is coverage you can RUN, not a CI gate; and a handoff to `task-filer` still
files **without** the confirm chip (the handoff click is treated as consent) — an owner decision left
open.

**Module manifest** (VERSIONING rule 2):

| Module | Ver | | Module | Ver |
|---|---|---|---|---|
| platform-nest | `0.16.0` | | webdev | `0.11.0` |
| platform-ui | `0.17.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.1` | | search-marketing | `0.5.1` |
| mcp-hub | `0.10.0` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| automation (n8n) | `0.4.1` | | render-gateway-go | `0.0.0` |
| observability | `0.6.1` | | reports | `0.3.1` |
| infra | `0.8.6` | | report-renderer | `0.1.0` |
| wa-chat-bot | `0.9.2` | | mail | `0.0.19` |
| ai-agents | `0.6.0` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

### `Alpha 01.022.0056a` — 2026-08-06 — the Hermes brain actually wins, and the badge can finally say so

Cut to deploy the one finding the `0052a` post-release live check turned up. That check asked for
"pick Hermes → confirm the badge names Hermes"; the badge said **CENTRAL-FORWARD**, and chasing it
found that **`ai-gateway-go`'s `hermes` provider had never once succeeded** — it sent no
`Authorization` header, and hermes-gateway authenticates *before* it routes, so every call 401'd.

It stayed invisible because a site-topology chain is `[hermes, central-forward, echo]` and this box's
`GATEWAY_CENTRAL_URL` points at that same hermes-gateway: hermes 401'd, central-forward answered, and
**Hermes replied every time anyway**. Two independent bugs would have been noticed; one bug masked by a
coincidentally-correct fallback was not.

- **ai-gateway-go `0.13.1`** — `HERMES_TOKEN` (falls back to `GATEWAY_TOKEN`), bearer sent on both
  endpoints, two regression tests. This changes which PROVIDER serves, **not which BRAIN** — unhinted
  callers reached Hermes via central-forward before and reach it natively now, so no topology decision
  was required and no caller's behaviour changes.
- **infra `0.8.5`** — `HERMES_TOKEN` passthrough, plus a warning on the `LLM_CHAIN` block that site
  topology silently strips gemini/claude/openai from whatever an operator writes there (the trap that
  made the brain picker look inert for *every* option, not just Hermes).
- **mail `0.0.18`** and the assistant a11y / VER-01..04 closures, PM TaskDrawer focus trap, platform
  OTel-survives-deploy compose fix, and the IdP password-reset findings — all from other sessions,
  committed and CI-green, previously unreleased.

Counter `0053 → 0056`: three module rows moved (ai-gateway-go, infra, mail). Note the assistant a11y and
PM fixes did **not** bump their modules' versions, so the counter understates this release's churn —
flagged rather than silently corrected, since those are other sessions' entries to write.

**Module manifest** (VERSIONING rule 2):

| Module | Ver | | Module | Ver |
|---|---|---|---|---|
| platform-nest | `0.15.0` | | webdev | `0.11.0` |
| platform-ui | `0.16.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.1` | | search-marketing | `0.5.1` |
| mcp-hub | `0.10.0` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| automation (n8n) | `0.4.1` | | render-gateway-go | `0.0.0` |
| observability | `0.6.1` | | reports | `0.3.1` |
| infra | `0.8.5` | | report-renderer | `0.1.0` |
| wa-chat-bot | `0.9.2` | | mail | `0.0.18` |
| ai-agents | `0.5.1` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

### `Alpha 01.021.0053a` — 2026-08-06 — REL-01's scoped SBOM goes live; the test-DB leak closed

Everything on `main` since the `alpha-01.020.0052a` tag's actual (tagged) content. Because that tag
points one commit later than its own changelog entry (see the mismatch note above), OBS-01
(`observability 0.6.1`) is already inside the `0052a`-tagged build and is **not** new module churn
for this cut — the only module that moved is `infra`.

- **`infra` `0.8.2` → `0.8.4`** (two bumps, one module — counts once toward the counter):
  - **`0.8.3` (INFRA-01)** — `teardownTestDb()` never dropped its database; root cause of the
    615-orphan `/dev/shm` exhaustion incident. Fixed with a fresh maintenance connection + `DROP
    DATABASE ... WITH (FORCE)`, try/catch/finally so a teardown hiccup can't fail a passing suite.
    Orphan backlog now at 1 (was ~565+).
  - **`0.8.4` (REL-01)** — `report-renderer`'s SBOM scoped to source (`syft dir:` on
    `./report-renderer`) instead of the built image, so it stops cataloguing the shared
    `mcr.microsoft.com/playwright` base: 17,080,639 bytes / 826 packages → 451,910 bytes / 229
    packages (~38x smaller), the component that had twice made Rekor reject the SBOM attest.
    `continue-on-error` **removed** from the attest step estate-wide — a genuine future attestation
    failure now fails the release loud instead of degrading silently. This release is the first
    live test of that change (see the "SBOM attest" result recorded by this cut's deploy report).
- **`e7f8144` (ASST-24 + VER-04)** — hermes-gateway forked-session signal fix, already on `main`
  from another session; carried through, not modified by this ticket. No module version bump
  recorded against it independently of the manifest below.
- **`441c5e5`** — docs-only (idp password-reset finding attributed to upstream Keycloak); no module
  version change.

Counter moves `0052 → 0053`: **one** module row bumped since the tag's real baseline (`infra`), so
the revision letter resets to `a`.

**Module manifest** (VERSIONING rule 2 — the exact set this build composes):

| Module | Ver | | Module | Ver |
|---|---|---|---|---|
| platform-nest | `0.15.0` | | webdev | `0.11.0` |
| platform-ui | `0.16.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.0` | | search-marketing | `0.5.1` |
| mcp-hub | `0.10.0` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| automation (n8n) | `0.4.1` | | render-gateway-go | `0.0.0` |
| observability | `0.6.1` | | reports | `0.3.1` |
| infra | `0.8.4` | | report-renderer | `0.1.0` |
| wa-chat-bot | `0.9.2` | | mail | `0.0.17` |
| ai-agents | `0.5.1` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

### `Alpha 01.020.0052a` — 2026-08-06 — the assurance ceiling closes; the agent-write surface goes live

The release the `0047b` report deliberately left to the owner, because a cut here ships **four
sessions' unreleased work**, not one. What it carries:

- **mcp-hub `0.10.0` — verified assurance can be minted at all.** The headline. `mintPrincipal` had put
  every envelope-derived principal at `low` and nothing minted `verified`, while
  `approvals.resolveExecute` requires it — so D14's agent-write half, PM Phase-4 `J2`'s write half,
  `ASST-23`, `D14-17` and Hermes' MCP authority were all the SAME gap. Three fail-closed conjuncts;
  chat surfaces deliberately stay `low`; n8n is refused outright per the binding §A13 ruling.
- **platform-nest `0.15.0`** — the IdP side of that vouching, plus **ASST-21** (agent roster + handoff)
  from another session, which was unreleased at `0047b`.
- **ai-agents `0.5.1`** — the runner presents the elevated token, carrying the triggering human's
  envelope.
- **infra `0.8.2`** — `HUB_ASSURANCE_TOKEN` passthrough to the four services that need it, plus the
  earlier unreleased `HERMES_URL`/`HERMES_MODEL` wiring (`48a9aa7`) and the deployed-tag `.env` write
  (`3960e88`).
- **mail `0.0.17`** — MAIL-24/25/26 + MAIL-27's corpus hardening, already recorded before this cut.

**Deployment note — three `.env` lines are required on the box for the Hermes half to do anything**
(`HERMES_URL`, `HERMES_MODEL`, and appending `hermes` LAST to `LLM_CHAIN`). Until they are set the
brain picker is an honest no-op: `chain.RunWithHint` only reorders a provider already in the chain and
an unmatched hint falls through silently. `HUB_ASSURANCE_TOKEN` is likewise **optional and
fail-closed** — unset, every `minAssurance:"verified"` tool denies exactly as it did before this
release, which is safe but indistinguishable from a bug without checking
`/admin/info`'s new `assuranceElevationConfigured` flag.

Counter moves `0047 → 0052`: five module rows bumped since that cut (mail, mcp-hub, platform-nest,
ai-agents, infra), so the revision letter resets to `a`.

**Module manifest** (VERSIONING rule 2 — the exact set this build composes):

| Module | Ver | | Module | Ver |
|---|---|---|---|---|
| platform-nest | `0.15.0` | | webdev | `0.11.0` |
| platform-ui | `0.16.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.0` | | search-marketing | `0.5.1` |
| mcp-hub | `0.10.0` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| automation (n8n) | `0.4.1` | | render-gateway-go | `0.0.0` |
| observability | `0.6.0` | | reports | `0.3.1` |
| infra | `0.8.2` | | report-renderer | `0.1.0` |
| wa-chat-bot | `0.9.2` | | mail | `0.0.17` |
| ai-agents | `0.5.1` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

### `Alpha 01.019.0047b` — 2026-08-06 — re-cut: an unordered LIMIT 1 picked a different constraint on the box

`0047a` never deployed. Every image built and signed, the new `.env` precheck passed (its first real
outing, and it did its job), and the deploy then failed at **Run migrations**:

    migration 0083_approval_status_cancelled.sql failed:
      constraint "automation_approvals_status_check" for relation "automation_approvals" already exists

`0083` located the constraint to widen the way 0028 did for `origin` — by substring-matching
`pg_get_constraintdef` for `%status%` and `%pending%`, with `LIMIT 1`. On this table that matches TWO
constraints, because 0078's `CHECK (execution_status IN ('not_applicable','pending',...))` contains
both: "status" as the tail of "execution_status", and "pending" outright. With no `ORDER BY`, which
one `LIMIT 1` returns is undefined — it chose the `status` constraint on a freshly-migrated test
database, so the local suite went green, and the `execution_status` one on the live box, where it
dropped that and then collided with the untouched `status` constraint it had never looked at.

**Nothing was damaged**: migrations are transactional, so the whole of `0083` rolled back, and all
four CHECK constraints were confirmed intact afterwards. The deploy rolled back to `0045a`.

Two lessons, and the second is the one worth keeping:

1. Identify a constraint by its COLUMN SET (`conkey`), not by substrings of its definition. The fix
   matches `array_agg(attname) = ARRAY['status']` — a single-column CHECK on `status` and nothing
   else — which cannot be fooled by a column whose name merely ends in "status".
2. **A green local suite proved nothing here, because the defect was nondeterminism.** An unordered
   `LIMIT 1` is a coin flip that can land differently per database, so "it applied cleanly to a fresh
   test DB" was luck rather than evidence. The fix was therefore dry-run against the LIVE schema —
   the only database that actually reproduced the failure — inside a rolled-back transaction that
   also asserted `cancelled` is accepted (6 real rows), junk is still refused, the other three
   constraints survive, and a second application is harmless.

Same module set as `0047a`, so the module-reference counter holds and only the revision letter moves.

### `Alpha 01.019.0047a` — 2026-08-06 — SUPERSEDED by 0047b, no deployment (migration 0083 failed)

A verification cut, not a feature cut. `0045a` deployed employee loans and this closes what that
release could not prove: `loans.test.ts` now drives approval → schedule → ledger → settle through
the real event pipeline against live Postgres + Cerbos + Redis, and found four defects doing it (a
latent one-day date shift east of UTC, a 403/404 existence oracle on the detail read, a 500 when an
employee withdraws their own request, and one wrong assertion of my own that read through RLS and
looked like a broken feature). Full writeup in the platform-nest 0.14.1 entry.

Carries migration `0083`, which widens `automation_approvals.status` to allow `cancelled` — a
requester retiring their own row, which the 0014 vocabulary had no word for. **Until this deploys,
withdrawing a pending loan request 500s on the live box**; that is the one user-visible reason this
cut exists.

Also folds in `infra 0.8.1`, cut after `0045a` and never yet released: the `bash -n` precheck on the
box's `.env` that stops a malformed value from failing the backup gate and rolling back an otherwise
green release.

| Module | Ver |
|---|---|
| platform-nest | `0.14.1` |
| platform-ui | `0.16.0` |
| ai-gateway-go | `0.13.0` |
| mcp-hub | `0.9.3` |
| sync-engine-go | `0.7.0` |
| automation (n8n) | `0.4.1` |
| observability | `0.6.0` |
| infra | `0.8.1` |
| wa-chat-bot | `0.9.2` |
| ai-agents | `0.5.0` |
| hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` |
| webdev | `0.11.0` |
| webdesk | `0.0.0` |
| search-marketing | `0.5.1` |
| social-media | `0.0.0` |
| creative | `0.1.0` |
| render-gateway-go | `0.0.0` |
| reports | `0.3.1` |
| report-renderer | `0.1.0` |
| mail | `0.0.15` |

### `Alpha 01.018.0045a` — 2026-08-06 — the employee portal, and the assistant's tool broker

First cut since `0040b`. Ten commits from several concurrent sessions; the two headline changes are
the employee portal (this session) and the assistant tool broker (another).

**Employee portal — waves A, E, F.** `/me` is a personal hub: a SECTION of the staff ERP, not a
second shell like `/portal`, because an employee already IS an ERP user and what was missing was a
HOME for the seven self-service surfaces scattered across Workspace/Business/Reports/Appraisals. It
is deliberately NOT under HR — HR manages employees to the extent HR needs; this is what the employee
owns. Employee loans land end-to-end (migration `0081`: agreement + a schedule FROZEN at approval +
an append-only ledger, all behind the `app_module_allowed('hr')` third wall), decided on the EXISTING
unified approvals surface at impact `high` rather than leave's `medium` because this one moves money.
A member may request but never repay: recording a repayment authorizes as `hr_case:update`, an action
the `member` derived role does not hold. `/me/inbox` unifies the notification feed with entity-scoped
mail threads — there is no personal-mailbox store, and inventing one would mean a second unread model.

**Also in this cut:** ASST-13/15/16/17/19 (egress-audit rows on `/complete/stream`, provider hint +
hermes as a gateway provider, per-thread brain picker, the tool broker running under the CHATTING
USER's principal, memory panel with propose/confirm quarantine), MAIL-10 magic links + inbound
truncation metadata, UI-01 deep-link-preserving reauth, and a `.gitattributes` pinning `*.go` to LF.

**Two process failures worth recording, because both were silent:**

1. **Main was pushed non-compiling for ~2 hours.** Commit `0bf1481` swept this session's two in-flight
   one-line edits (`app.module.ts` registering a controller, `demoFixtures.ts` wiring a demo store)
   into itself WITHOUT the files those imports point to, which were still untracked. Neither
   `git status` nor `git diff HEAD` showed those files as modified afterwards — the tell that someone
   else had already committed them. `b17b7dc` closed it. This is the shared-working-tree trap from the
   other direction: previously documented as *my* commit sweeping *their* staged files.
2. **`mail 0.0.15` has no CHANGELOG entry** (rule 1). The registry table moved without one, so this
   release's module-reference counter is derived from the five actual version MOVES in `MODULES.md`
   (`platform-nest` ×1, `platform-ui` ×2, `mail` ×2), not from the four recorded entries. Whoever cut
   `mail 0.0.15` should add it; not back-filled here because its contents are not known to this session.

**Verification standing at cut time:** `tsc` clean across both platforms, 1145 platform-ui tests,
19 loan-arithmetic tests, both migration lint gates, `DEMO_MODE=1 next build` green. The HR
integration suite needs live Postgres + Cerbos + Redis, which the dev box does not run — CI caught two
count assertions wave E's three new tables shifted (`8703179`), which is exactly the class of defect
that gap hides. The approval→schedule path still needs an on-server pass after this deploys.

| Module | Ver |
|---|---|
| platform-nest | `0.14.0` |
| platform-ui | `0.16.0` |
| ai-gateway-go | `0.13.0` |
| mcp-hub | `0.9.3` |
| sync-engine-go | `0.7.0` |
| automation (n8n) | `0.4.1` |
| observability | `0.6.0` |
| infra | `0.8.0` |
| wa-chat-bot | `0.9.2` |
| ai-agents | `0.5.0` |
| hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` |
| webdev | `0.11.0` |
| webdesk | `0.0.0` |
| search-marketing | `0.5.1` |
| social-media | `0.0.0` |
| creative | `0.1.0` |
| render-gateway-go | `0.0.0` |
| reports | `0.3.1` |
| report-renderer | `0.1.0` |
| mail | `0.0.15` |

### `Alpha 01.017.0040b` — 2026-08-05 — re-cut: Rekor would not take report-renderer's SBOM

`0040a` never deployed. `build-sign (report-renderer)` failed twice on the SBOM attestation —
`POST https://rekor.sigstore.dev/api/v1/log/entries giving up after 4 attempt(s)`, each time after
cosign's own 4 retries — and because `deploy` declares `needs: build-sign`, the whole deploy was
**skipped**. A supply-chain nicety stopped a production deploy that was otherwise green.

Revision letter, not the counter: no module changed, only `release.yml` (VERSIONING: "an infra/CI change
that touches no module is exactly this case — bump the letter").

`cosign attest` is now `continue-on-error`. That is **not** a weakened deploy gate: deploy.yml's
"Verify image signatures" step runs `cosign verify` — the signature only, never
`cosign verify-attestation` — and `cosign sign` succeeds for every component including this one. What is
genuinely lost is the attested SBOM in the public transparency log for `report-renderer`, whose Chromium
layers make its SPDX predicate far larger than the rest. The proper fix, left as follow-up: SBOM the app
layers rather than the whole base image, or attest that one component with `--tlog-upload=false`, then
make the step blocking again.

Code is unchanged from `0040a`, which CI passed at `429c5ea`.

### `Alpha 01.017.0040a` — 2026-08-05 — back on the pipeline; supersedes the hand-built release

**The first properly built, signed release since Actions was blocked.** `01.016.0037a` was hand-built on
the VPS with no cosign signature and no attested SBOM, and it was still what production was running —
this cut replaces it through `release.yml`, restoring the supply-chain gate `deploy.yml` enforces. It
also has a git tag, which `01.016.0037a` never got (VERSIONING rule 4: the deployed tag matches the app
version).

Counter `0037 → 0040`: three modules bumped — `platform-nest 0.13.0 → 0.13.1`, `platform-ui 0.15.1 →
0.15.2`, `mail 0.0.1 → 0.0.13`.

Contents (four programs that had accumulated on `main` unversioned, plus one fix):

- **the Zone A mail subsystem** — approvals + risk email, inbound threads, mail UI, with migration
  **`0077_mail_core.sql`**. This release is what first applies it to production.
- **the D14 resume path closed** + **ERP assistant phases 0–1**, then ASST-09 (nginx SSE block + env
  passthrough), ASST-11/12 (meta/usage wire events, brain badge and a truthful cost meter), ASST-14
  (hermes-gateway streamed spawn + incremental box parser), and D14-15 (PM executable registry).
  `D14 has no resume path` was a standing platform-wide blocker; it is closed here.
- **`fix(seed)!`: the hard-coded portal password is gone.** Going public on 2026-08-05 made
  `"PortalDemo!2026"` world-readable **while those seven accounts were live**, so anyone reading the seed
  could sign into a real client's portal. All seven were rotated on the box and verified both directions
  (old rejected at Keycloak, new one lands on `/portal`); the seed now generates a random password per
  run so there is no literal left to leak.

Two settings corrected now that the repo is public and storage is free again:

- **GHCR retention 9 → 30** (3 releases → 10). Nine was chosen only to fit the free *private* Packages
  allowance; it left a late-noticed regression with no tag to roll back to.
- **SLSA provenance** is expected to work now (it needs a public repo). `continue-on-error` is left on
  for exactly one release so the outcome is observed rather than assumed — if the step passed on this
  run, remove that line so a future provenance failure is loud.

**Module manifest (21) — as of this commit.** Recorded with a caveat: other sessions were editing
`MODULES.md` in the shared checkout while this was written (`mail` moved `0.0.12 → 0.0.13` between two
reads), so treat the three IN PROGRESS rows as a snapshot, not a settled state.

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| platform-nest | `0.13.1` | wa-chat-bot | `0.9.2` | webdesk | `0.0.0` |
| platform-ui | `0.15.2` | ai-agents | `0.5.0` | search-marketing | `0.5.1` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` | social-media | `0.0.0` |
| mcp-hub | `0.9.3` | capture-helper | `0.2.0` | creative | `0.1.0` |
| sync-engine-go | `0.7.0` | webdev | `0.11.0` | render-gateway-go | `0.0.0` |
| automation (n8n) | `0.4.1` | reports | `0.3.1` | report-renderer | `0.1.0` |
| observability | `0.6.0` | infra | `0.8.0` | mail | `0.0.13` |

Pre-cut verification (local, before pushing three other sessions' commits): `platform-nest` and
`platform-ui` `tsc` clean, `platform-ui` **1108 tests** across 108 files, `DEMO_MODE` build green. The
DB-backed suites — including the 32-case client-portal isolation suite, which passed in CI run
`30989473747` — are CI's job and gate this tag.

### `Alpha 01.016.0037a` — 2026-08-04 — HAND-BUILT deploy (Actions blocked), carrying wd23a-1

**⚠ This cut did NOT go through `release.yml`.** GitHub Actions is blocked by billing — every job dies
in ~10s with `steps=0` — so the image was built **on the VPS** from `git archive HEAD` and tagged
locally. Consequences, stated rather than buried:

- **No cosign signature and no attested SBOM.** `deploy.yml` verifies both before it deploys; this
  bypassed that gate entirely. The supply-chain assurance for this one release is "the build ran on the
  target box from a clean export of a known commit", which is weaker than every release before it.
- **The image exists only on the box, not in GHCR.** A `docker compose pull` for `platform-nest` at this
  tag will 404. Recreating the container is fine (the image is local); `--pull always` is not.
- **Re-cut it properly the moment Actions returns**: `gh workflow run release.yml` on a real tag. This
  entry exists so that is not forgotten.

Contents — one component changed since the deployed `alpha-01.014.0035a` (verified per component with
`git diff --name-only`; the other eight are byte-identical, so only `platform-nest` was rebuilt):

- **`platform-nest 0.12.2 → 0.13.0` — the Google OAuth state machine moved to core**, from another
  session's `wd23a-1` work (`1ffb60c`, `e7b446e`), including migration **`0076_core_google_oauth_states.sql`**
  (`google_oauth_states`, FORCE RLS). Not my change; versioned here because the app version records what
  is DEPLOYED, and this is what is deployed.
- the two remaining portal-seed fixes (`e8c76fd`, `e7d7857`).
- CI cost control + GHCR retention (`397e471`, `10a992c`) — infra, no module.

**Verification that replaced CI**, since CI could not run:

| Check | Result |
|---|---|
| `platform-nest` typecheck at HEAD, in a clean throwaway worktree | `tsc` exit 0, no output |
| Full migration set from EMPTY, real migrator, disposable `postgres:15` container with the real NOSUPERUSER/NOBYPASSRLS role set | **75 applied**, `0076` in the ledger, `google_oauth_states` + `contracts` both `forceRLS=t` |
| Per-component diff vs the deployed tag | only `platform-nest` changed |

A disposable container was used rather than the live cluster because `platform_owner` correctly lacks
`CREATEDB` — it cannot make itself a scratch database, which is the right posture and the reason this
check has to bring its own Postgres.

**What was NOT verified:** the DB-backed suites (the 32-case portal isolation suite, RLS, Cerbos). Those
only run in CI. Migrations applying is not the same as behaviour being correct — treat this release's
runtime behaviour as PROTOTYPED, not DEV-VERIFIED.

### `Alpha 01.015.0036a` — 2026-08-04 — the seed hit its own RLS wall

`portal-workspace.js` ran on the live box and skipped **all five** clients with
*"run seed:agency then the portal-clients seed first"* — immediately after those seeds had printed
those same five clients as succeeding. The prerequisite was fine; the seed was wrong.

`findClient` read `clients` through `withGlobal`, on the reasoning that the seed does not know which
member company serves a client. True, and not a licence to skip the tenant context: `clients` is FORCE
RLS and the seed runs as `platform_app` with `bypassrls = false`, so with no `app.current_tenant_ids`
GUC the policy matched **nothing**. `anyStaffUser` had the same bug over `company_memberships` +
`client_contacts`, which would have left every project unowned — the one thing that function exists to
prevent, since the portal resolves notification recipients from `projects.owner_id`.

Verified against the live catalogue rather than assumed: only **`companies` and `users`** are RLS-free;
`clients`, `client_contacts`, `company_memberships`, `projects`, `invoices` and `contracts` are all
FORCE RLS. Both lookups now go through `withTenants`, searching company by company.

The "skipped" message also blamed only the prerequisite, sending the reader to re-run a seed that had
already worked. It now names both causes and says how to tell them apart — a zero-row RLS read and a
missing prerequisite are indistinguishable from the outside, which is the whole difficulty.

`platform-nest` `0.12.1 → 0.12.2`.

### `Alpha 01.014.0035a` — 2026-08-04 — data to look at, and a lie to a customer

Closes the gap that made the deployed client portal unusable: it was authorized, routed and empty. The
live database had 3 companies and 47 users but **zero clients, projects, invoices or contracts**, and
zero `client_contacts` rows — so all nine `client`-role accounts resolved to 403.

- **`seed/portal-workspace.ts`** — the half of the portal demo `portal-clients.ts` never covered:
  milestones, tasks (they drive every progress %), deliverables with attachments, invoices, the payment
  ledger, and contracts with signatures. Deliberately **uneven across five clients**, because the
  branches that break are the ones no fixture reaches: an overdue milestone, an overdue invoice, a
  partial payment, a payment awaiting verification, a **rejected** payment with a reason, a voided
  invoice, a voided agreement, an agreement countersigned by us and waiting on the client, an agreement
  nobody has signed, a fully-signed one, a **view-only contact who cannot sign**, a delivered item with
  no file, and a settled account. Idempotent; `files` rows are reference attachments (a URL, no
  `storage_key`) because a seed cannot write bytes into the storage volume and a metadata row pointing
  at nothing produces a download that 404s.

- **A false statement to a customer, fixed.** `/portal` answered a 403 from the BFF with "You're signed
  in as a staff member" — but that 403 covers **two** people: a staff member, and a genuine client whose
  contact row does not exist yet or was revoked. Nine real client accounts on the live box would have
  been told they were staff. `isClientOnly(me)` is the discriminator the UI already had; clients now get
  "your portal isn't linked yet — nothing is wrong on your side".

Counter `0033 → 0035`: `platform-nest` `0.12.0 → 0.12.1`, `platform-ui` `0.15.0 → 0.15.1`.

**No npm script was added for the new seed** — `platform-nest/package.json` carries a concurrent
session's uncommitted `seed:departments` line, and staging it would have dragged their work into this
commit. Run it as `node dist/seed/portal-workspace.js`; the script can be added by whoever lands that.

### `Alpha 01.013.0033a` — 2026-08-04 — the client portal

The client side gets its own interface. Contents: the CP-* program — `(portal)` route group (11
routes, own shell), the portal BFF (workspace · commerce · profile · SSE stream), migration `0075`
(`contracts`, `contract_signatures`, `invoice_payments`), the staff contract/payment-confirmation
counterpart, `resource_contract.yaml` + two new `portal` actions, an nginx SSE location block, and an
explicit Cerbos-reload step in `deploy.yml`. Full detail:
[`docs/plans/2026-08-04-client-portal-deployment.md`](../plans/2026-08-04-client-portal-deployment.md)
and §16 of [`../FRONTEND-BFF-CONTRACT.md`](../FRONTEND-BFF-CONTRACT.md).

Counter moved `0031 → 0033`: two modules bumped (`platform-nest` `0.11.1 → 0.12.0`, `platform-ui`
`0.14.0 → 0.15.0`), so the revision letter resets to `a`.

**⚠ This cut carries the first execution of migration `0075` against a real database.** It was
developed with no local Postgres and no Docker daemon available, so it is hand-reviewed but
**never applied anywhere** — and it `ALTER`s four existing tables (`clients`, `projects`, `invoices`,
`files`) to add the composite uniques its tenant-scoped FKs need. The 25-case DB-backed portal
isolation suite has likewise never run. CI is the gate; see the deployment plan §7.

**Module manifest (21 — the full registry):**

| Module | Ver | Module | Ver | Module | Ver |
|---|---|---|---|---|---|
| platform-nest | `0.12.0` | wa-chat-bot | `0.9.2` | webdesk | `0.0.0` |
| platform-ui | `0.15.0` | ai-agents | `0.5.0` | search-marketing | `0.5.0` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` | social-media | `0.0.0` |
| mcp-hub | `0.9.3` | capture-helper | `0.2.0` | creative | `0.1.0` |
| sync-engine-go | `0.7.0` | webdev | `0.10.0` | render-gateway-go | `0.0.0` |
| automation (n8n) | `0.4.1` | reports | `0.3.1` | report-renderer | `0.1.0` |
| observability | `0.6.0` | infra | `0.8.0` | mail | `0.0.0` |

### `Alpha 01.010.0029a` — 2026-08-04 — the team's UI branch, consolidated (manifest recorded after the fact)

Cut by a concurrent session for its client-portal fix. Recorded here because **the same cut also
shipped the whole `reva/ui` consolidation**, which would otherwise appear in no release entry at all:
merge `04459ef` is an ancestor of this cut, so reva's work is inside `platform-ui 0.12.0` rather than
awaiting a version of its own. No second cut was made for it — the work is already versioned; only
the record was missing.

**Branch audit that produced it.** Of five remote branches only `reva/ui` still held unmerged work —
15 commits, 79 files, 59 behind main. `fix/backup-silent-skip-and-n8n-overlay`, `zafir/ui`, `UI` and
`trial/alpha-cut` were already absorbed. **Every remote branch is now `ahead=0`.** That branch never
touched `VERSION` or `MODULES.md`, which is why its work arrived unversioned.

**From `reva/ui`:** a token layer (`styles/tokens/`, 5 files) moving the chart palette out of
component CSS, with light + both dark blocks and the parity test now covering chart colours, and 5
hard-coded colours fixed — including `--erp-ink-40`, which was defined nowhere and had been silently
rendering its `#999` fallback with no dark-mode value. `/calendar` rewritten (personal focus, real
month/week/day grids, explicit "N of yours have no date — not shown here"). PM tasks in a slide-over;
the Gantt no longer re-renders itself to death without a `groups` prop. Dashboard hierarchy, state-
legible inputs, loading feedback, unboxed empty states, one-line page header, KPI tiles that explain
the rule their label hides, a Settings → About page, and a component guide. Plus two real fixes:
**My Work was blind to every PM task** (the queue read core `tasks` while the app writes `pm_tasks`,
and never loaded `lib/pm`'s `statusFlags` — structurally empty while looking healthy), and
**`seal_hash` verified nothing** (`canonicalStringify` mishandled `undefined`, so a freshly-built
document and the same document re-read from JSONB hashed differently; a tamper check that never
reproduces is indistinguishable from one that caught tampering). Main had fixed the seal bug
independently — what reva adds is `report-seal.hash.test.ts`, the regression test it shipped without.

**From the concurrent session:** the client portal could never have shown a client anything, plus
migration `0074` backfilling `pipeline_runs.client_id` from the source meeting.

Merge resolutions for the 10 conflicting files are in `04459ef`. Two worth repeating: `/calendar`
took reva's side wholesale because the rewrite deletes a workload panel `0.10.3` had just repaired —
the rewrite serves that fix's purpose better; and `report-seal.ts` kept main's implementation because
it also closes the `toJSON()` case reva's did not, while keeping reva's test.

Verified on the merge result rather than on either side: both `tsc` clean, `next build` green,
**974 UI tests pass** (945 before — 29 new), CI green on main including the DB suites.

| Module | | Why |
|---|---|---|
| platform-ui | `0.11.0 → 0.12.0` | reva/ui design-system pass + queue PM-task fix; concurrent session's portal fix |
| platform-nest | `0.10.0 → 0.11.0` | concurrent session's portal/pipeline fix + `0074`; reva's `report-seal.hash.test.ts` |

> **Ledger gaps, recorded rather than invented.** Rules 1 and 2 (every notable module change gets an
> entry; every app version records its manifest) are currently unmet for several cuts, across both
> sessions and including my own. Still owed: the **`Alpha 01.009.0028a`** app entry (webdev W0/W1 +
> infra deploy fixes; it moved five modules against a counter that advanced by one); per-module
> entries for **platform-ui `0.10.4`, `0.11.0`** and **platform-nest `0.9.5`, `0.10.0`** — `0.10.4`
> and `0.9.5` are mine, from the `0027a` cut, where I bumped `MODULES.md` without writing the module
> sections. Left for whoever holds the context on each rather than reconstructed from commit messages
> here. Deployed tags are untouched; the consequence is only that counter gaps understate churn.

### `Alpha 01.008.0027a` — 2026-08-03 — a workflow is a principal, not a colleague

HR reported 36 people. 19 were people; **17 were n8n automation service accounts.**

Non-human principals are `users` rows on purpose — authorization is defined over principals, and
`OBO envelope -> identity_links -> users -> user_roles -> Cerbos` is the only path to being
authorized at all. (Proven the hard way the same day: five unseeded `wf:reports-*` accounts made
every reports CRON fail `403 cerbos denied`.) The cost of that design is that "principal" and
"person" are different sets, and every people-shaped surface has to know it.

`company_memberships.kind ('employee','service')` — added by `0026` for the shared-service
reconciler — already existed for this, and `GET /api/:t/members` already filtered on it. Two gaps:

- **Nothing ever set it.** The seed calls `addMembership()`, which never passed `kind`, so all 17
  accounts took the column default `'employee'`. Zero `service` rows existed. `addMembership()` now
  takes `kind`, and the automation seed passes `'service'`.
- **`GET /api/:t/users` had no filter at all** — and that, not `/members`, is what backs the People
  directory and HR. Now employee-only by default with `?includeService=1` to opt in, matching the
  `/members` convention. Settings → Users & Roles opts in and badges the row (that is where
  automation grants get audited and revoked); the directory and HR take the default.

Reconciler-safe: it only deletes rows that are `kind='service'` **AND** `managed_by IS NOT NULL`,
and seeded automation memberships have `managed_by NULL`.

Interim by design. Reusing `company_memberships.kind` overloads one column with two questions —
*why is this principal in this company* vs *what kind of account is this* — and they are independent
axes (a served-company HR manager is a human with `kind='service'`). The owner-approved target is
`users.kind` with **four** kinds — `employee`, `client`, `automation`, `bot` — keeping `bot` distinct
from `automation` because a Hermes persona's next action is not enumerable the way a pinned workflow
allow-list is. Design + migration sketch: `docs/superpowers/specs/2026-08-03-principal-kinds-design.md`.

| Module | | Why |
|---|---|---|
| platform-nest | `0.9.4 → 0.9.5` | `/users` employee-only + `?includeService=1` + `isService`; `addMembership(kind)`; automation seed tags `service` |
| platform-ui | `0.10.3 → 0.10.4` | `listUsers(includeService)`; Users & Roles opts in and badges; directory/HR exclude |

### `Alpha 01.007.0025a` — 2026-08-03 — the ten identical "manager" options were ten real rows

**Corrects the previous release.** `0024a` shipped a tenant-narrowed roles catalog and reported the
duplicate-role-picker bug as fixed. It was not: that change was verified by `tsc` and unit tests,
never against the live symptom. Re-checking the deployed build showed the picker still offering
`manager` ten times, `company_admin` three times and `member` twice.

The cause was not cross-company name collision at all. Every role in the table is GLOBAL
(`company_id IS NULL`), and there were genuinely ten `manager` ROWS. `roles` has carried
`UNIQUE (company_id, name)` since `0001`, which reads as though it protects this — but SQL treats
NULLs as DISTINCT for uniqueness, so `(NULL, 'manager')` never collides with `(NULL, 'manager')`.
Every global role has always been exempt from the constraint that appears to cover it.

The inserter closed the loop: `createRole()` used `ON CONFLICT (company_id, name) DO NOTHING`, whose
conflict target likewise never matched for a global role — so `DO NOTHING` never fired and each run
of the re-runnable seed appended another row. Ten `manager` rows ≈ ten seed runs; the lower counts on
`company_admin`/`member` just mean they joined the seed later.

- Migration `0073` collapses the duplicates and adds `roles_global_name_uniq ON roles (name) WHERE
  company_id IS NULL` — a partial index, which is what `0001` was reaching for.
- **The dedupe repoints before it deletes.** `user_roles.role_id` and `role_permissions.role_id` are
  `ON DELETE CASCADE`, so removing the losing rows first would have silently stripped every grant
  held against them and still reported success.
- `company_memberships.primary_role_id` is repointed per tenant under
  `set_config('app.current_tenant_ids', …)`. The repo's own migration lint caught this: that table is
  FORCE-RLS, migrations run as `platform_owner` (NOBYPASSRLS), so a bare `UPDATE` would have matched
  ZERO rows and committed happily — the exact failure `0050` shipped and `0051` had to repair.
- `createRole()` and `teams.controller.ts`'s check-then-insert now target the partial index, so the
  seed stays idempotent and the previously-silent `team_lead` race resolves instead of duplicating.

The `0024a` roles change is kept: narrowing the catalog to the active tenant is still correct for
per-company roles, which the original constraint DOES protect. It was necessary and insufficient.

| Module | | Why |
|---|---|---|
| platform-nest | `0.9.3 → 0.9.4` | migration `0073` (dedupe global roles + partial unique index); `createRole`/`team_lead` conflict targets corrected |

### `Alpha 01.006.0024a` — 2026-08-03 — the surfaces that reported something untrue

Cut from a full audit of the live site: signed in as a real user and drove all 84 routes under both
companies, so "empty because this tenant has no data" could be told apart from "broken". Every
finding here is a surface that **claimed a state it was not in** — the failure mode that costs the
most trust, because nothing looks wrong.

The audit's own headline was config, not code: `enabled_modules` held `{agency, hr}` on Gaia and
`{}` on Sanur, so eight compiled-in modules were dark. Enabling them (all 10 on Gaia, 9 on Sanur)
lit up clients, billing, reports, appraisals, knowledge, IT and PM with real data — and cleared the
stalled delivery pipeline as a side effect: the WS11 fan-out had been dying on
`/api/:t/pm/projects/:id/docs 404`, which was the PM module being off, not a workflow bug.

- **`Open in n8n` pointed into the compose network.** `detail.n8nUrl` was assigned from
  `services.automation.url` — the in-cluster base (`http://n8n:5678`) the platform calls the Public
  API on. The console reported the service healthy and listed its workflows while offering a link no
  browser could follow. Split into `AUTOMATION_PUBLIC_URL`; absent ⇒ the UI hides the button.
- **The roles picker offered ten identical options.** `GET /api/roles` returned every company's role
  rows, and per-company roles share names, so `manager` appeared ten times with nothing to tell them
  apart — nine of them granting a row owned by another company.
- **HR contradicted itself on one screen.** The scope selector called every company "served" (an
  elevated caller was folded in as a `home` grant) while the envelope beneath it reported those same
  companies "not served".
- **A task you just created vanished.** The default all-companies leg is assignee-scoped, so an
  unassigned task was invisible with no affordance to reveal it.
- **The calendar workload panel demanded a narrowed scope** while all-companies is the default — dead
  for every visitor. Now breaks down by company instead.
- **React #418 on three Systems consoles** — bare `toLocaleString()` renders in the container's UTC
  server-side and the visitor's zone client-side, so React discarded the server HTML. Fixed with a
  fixed-zone `formatTimestamp()`.
- **Staff were told a client project was on its way to them.** The portal BFF 403s "not a portal
  client" for any staff member; the reader folded that into an empty list.
- **The platform read the bot's admin token from a different `.env` name than the bot** — it got an
  empty token, every proxy call 401'd, and the console said "bot admin unreachable" as though the bot
  were down.
- **n8n was proxied on eight ERP root paths** (`/webhook`, `/form`, `/mcp` + variants) because
  `N8N_WEBHOOK_URL` was the bare origin. Narrowed to `/n8n/` only; the first platform-ui route under
  any of those names would otherwise have been silently answered by n8n.

Also found and **not** fixed here, since neither is code: the n8n Public-API key held only the four
read scopes (`workflow:activate` missing ⇒ the ACTIVATE button returned `Forbidden`), and its
replacement was minted with all 72 — over-granted, on the rotation queue. And no client portal user
is provisioned, so that surface is still unexercised end-to-end.

Two corrections to the audit's own first pass, recorded because both were wrong in the same
direction — assuming a missing endpoint: `/rollups` and the services API were probed on the wrong
paths (`/api/rollups` is tenant-less; service assignments live under
`/api/:t/org-structure/service-units`), and the client portal was never broken.

| Module | | Why |
|---|---|---|
| platform-nest | `0.9.2 → 0.9.3` | tenant-narrowed roles catalog; `n8nUrl` split from the in-cluster base via `AUTOMATION_PUBLIC_URL` |
| platform-ui | `0.10.2 → 0.10.3` | six honesty fixes: roles picker, HR scope, tasks empty state, calendar workload, hydration-safe timestamps, portal staff view |
| infra | `0.7.3 → 0.7.4` | platform falls through to `ADMIN_TOKEN` for the bot proxy; n8n triggers no longer squat the ERP root; `AUTOMATION_PUBLIC_URL` wired; `*.local.md` ignored |

### `Alpha 01.005.0021a` — 2026-08-03 — the module switch works in both directions

First cut that carries the IT discovery work (`0.9.0`/`0.10.0`), which was committed but never
tagged — `0015b`'s deploy died mid-`docker pull` on a `connection reset by peer` and auto-rolled back
to `0015a`, so the box has been serving `0015a` while `/VERSION` claimed `0015b`.

Reported as "I disabled a module to see the difference and now it's gone." Both halves were real:

- **The toggle was one-way.** Settings → Modules & Fields rendered `union(["agency"], enabled_modules)`,
  so disabling a module removed the key AND the row that offered to re-enable it. Recovery required
  SQL. The list now comes from the compiled-in catalog.
- **The company edit form silently stripped modules** — it knew only `agency` and sent that derived
  set as `enabled_modules`, so renaming a company dropped `hr`/`reports`.
- **A disabled module looked identical to an empty one.** Nothing outside the settings page read the
  flag, so gated pages stayed clickable and returned nothing. They now say so, and say how to undo it.

Found live on `gda-aicenter`: Gaia Digital Agency held `{agency}` where the seed grants
`{agency, hr, reports}`. `hr` was restored by hand before this cut; **`reports` is deliberately still
off** — the owner was mid-experiment with it.

| Module | | Why |
|---|---|---|
| platform-nest | `0.8.1 → 0.9.2` | IT discovery + device writes (`0.9.0`, previously untagged); module catalog endpoint (`0.9.1`); `enabledModuleKeys` + per-tenant `modules-enabled` (`0.9.2`) |
| platform-ui | `0.6.5 → 0.10.2` | real IT topology + device edit/remove (`0.10.0`, previously untagged); two-way module toggle (`0.10.1`); legible module-disabled state (`0.10.2`) |

### `Alpha 01.005.0015b` — 2026-08-03 — index the tasks people actually use

`0015a`'s first live sweep on `gda-aicenter` ingested 130 sources / 306 chunks with 0 errors, and
the per-table counts matched the sources exactly (projects 5→5, pm_docs 1→1, meetings 3→3) — except
tasks, which produced **nothing**. Not a silent no-op: the core `tasks` table genuinely holds 0 rows.
The PM console writes `pm_tasks`, which held the real backlog of 6.

So the corpus was task-free while looking healthy — exactly the failure the run summary is supposed
to make visible, caught by reconciling its numbers against the source tables rather than trusting
"0 errors".

`pm_tasks` is now indexed alongside the core table (both are real, and a tenant may populate either),
carrying the fields the PM row actually has: description, progress %, milestone, tags, and the JSONB
poly-assignee — rendering BOTH the assigned party (which may be a person, division or department)
and the named responsible human, because "who is doing this?" and "who is accountable?" are
different questions.

| Module | | Why |
|---|---|---|
| platform-nest | `0.8.0 → 0.8.1` | `pm_tasks` source builder in the knowledge ingester |

### `Alpha 01.005.0015a` — 2026-08-03 — knowledge/RAG gets a two-tier corpus and something to retrieve

Status: **PROTOTYPED** (unit- and store-verified; the live sweep on `gda-aicenter` is the
DEV-VERIFIED gate).

The D9 vector store had been correct and completely **empty** since it was built —
`knowledge_chunks` held 0 rows on the server, so every `knowledge.search` returned nothing. It also
had no way to express public company knowledge: `store.search()` returned `[]` for any caller
without a resolved tenant, so a lead or client could never be answered at all.

| Module | | Why |
|---|---|---|
| ai-agents | `0.4.0 → 0.5.0` | D9.4 `audience` tier (`public`/`internal`) in the store + service; `/search` no longer needs an OBO envelope; fail-closed default |
| platform-nest | `0.7.1 → 0.8.0` | the ingestion module: gaiada.com crawler, ERP source builders, sweep scheduler, admin trigger/status endpoints |
| mcp-hub | `0.9.1 → 0.9.2` | `knowledge.search` describes both tiers; `scope` now optional |
| wa-chat-bot | `0.9.1 → 0.9.2` | `/know` no longer claims a verified identity is required for all results |
| infra | `0.7.2 → 0.7.3` | `KNOWLEDGE_INGEST_*` compose wiring |

**Two tiers.** `public` is the gaiada.com corpus, world-readable with no identity at all — that is
what lets an agent answer a lead or client who has no ERP account. `internal` is ERP content
(clients, projects, tasks, deliverables, meeting transcripts, PM docs, latest-revision reports,
files, org structure, people) under the unchanged D9.1 tenant pre-filter. The tier is a SQL
disjunction whose internal branch self-disables on an empty tenant set, so an unauthorized chunk is
never a ranking candidate, and `audience` fails closed — anything not literally `"public"` is
internal, and the in-place column default can only narrow visibility on existing rows.

Notable within the cut:
- **Retirement is gated on a clean run.** The sweep deletes stored sources it did not re-ingest, but
  only if the build succeeded and produced something — otherwise a transient DB error would look
  identical to "everything was deleted upstream" and one bad run would wipe the corpus.
- **Boilerplate is stripped by frequency, not by tag.** The live site's nav is not in a `<nav>`
  element, so tag-stripping alone put the whole menu in the first chunk of every page.
- The store's D9 suite had **never actually run against pgvector** — a 64-d fixture embedder against
  a 768-d column meant it silently only exercised the array fallback. Fixed; 13/13 now pass on real
  pgvector against the server's own cluster.

Dead tags, for the record: `alpha-01.004.0006a` never built (its commit swept in unrelated in-flight
IT-discovery edits whose module file was untracked, breaking `tsc`), and `alpha-01.004.0006b` built
but died at the same backup gate `0014b` fixes. Neither reached the server; this cut supersedes both
and is rebased on `0014b`, so it carries that fix rather than a competing one.

Known limits carried forward: PDF/DOCX bodies are metadata-only by design, and ACL sub-scoping stays
unsafe while `scope` is caller-supplied (see `platform-nest/src/modules/knowledge/README.md`).

### `Alpha 01.005.0014b` — 2026-08-03 — re-cut: the backup gate rejected its own compose project

Identical module set to `0014a` (hence a letter bump, not a counter move — "a re-tag after a failed
deploy" is exactly what the revision letter is for). `0014a` built and signed all 9 images
successfully, then **`deploy` failed at the backup step, before pull/migrate/up — production was
never touched** (containers stayed up 2–3 days; `erp.gaiada.online` served throughout).

```
backup FAILED: cannot read compose project (service pg-bot):
service "platform" depends on undefined service "postgres": invalid compose project
```

`backup.sh` required its CALLER to pass the `hostdata` overlay, and the caller that matters most
never did: `deploy.yml` has `COMPOSE_FILES` in its job env but does not forward it across the
`ssh vps` that runs the script, so the box got the single-file default. On a host-Postgres box the
base file alone is an invalid project. Because the backup is deliberately the **gate for
migrations**, that is a hard stop for the whole deploy rather than a degraded backup.

Sharp edge worth naming: it had backed up cleanly ten minutes earlier. `deploy.yml`'s rsync step
runs **before** the backup, so the box was already holding the newer `vps.yml` when the backup ran
— the failure needed the new compose file and the old call site together.

- **Fix:** `backup.sh` now picks up `docker-compose.hostdata.yml` automatically whenever it sits
  next to the base file, instead of relying on every call site to remember. An explicit
  `COMPOSE_FILES` still wins. This also repairs the **nightly cron backup**, which had the same
  defective invocation. Verified on gda-aicenter: all 5 databases + the WAHA volume, exit 0.
- Folded into `infra 0.7.2` rather than opening `0.7.3`, since `0014a` shipped nothing — keeping
  the module set identical is what makes the letter bump the honest description.

**Rollback is broken for any release that ADDS a service** — flagged, not fixed here. The failure
path ran `up -d` at the previous tag and died on
`ghcr.io/hansel-gaiada/gaiada-report-renderer:alpha-01.004.0005a: not found`, because
`report-renderer` did not exist at that tag. Harmless this time (nothing had changed, so there was
nothing to undo), but a genuine deploy would have been left half-rolled-back. `deploy.yml`'s
rollback needs to roll back only services present in the previous tag.

### `Alpha 01.005.0014a` — 2026-08-03 — SUPERSEDED, no deployment (see 0014b above)

Carries the tracker/multi-grain-reporting programme, the search-marketing SEM/Google-Ads work, the
`report-renderer` sidecar, the in-ERP audio/video recorder, the webdev server fixes, and the n8n
console at `/n8n/`. Ships migrations **0064–0069 + 0072** (the box is at 0063).

> **Migration gap, flagged not fixed:** `0070` and `0071` do not exist in the repo at this commit —
> `0072` was committed while they were still uncommitted in another seat's tree. The runner applies
> unapplied files in filename order, so if `0070`/`0071` land later they will execute *after*
> `0072` has already run. Harmless only if they are independent of it. Worth resolving before the
> next cut rather than discovering it as a failed migration.

**Counter derivation (`0005 → 0014`, +9; letter resets to `a`).** Counted as bump *steps* per rule 3
("don't flatten it by batching bumps into one"), read from the `MODULES.md` registry:

| Module | at `01.004.0005a` | now | steps |
|---|---|---|---|
| platform-ui | `0.7.1` | `0.9.0` | 2 |
| reports | `0.1.0` | `0.3.1` | 3 |
| infra | `0.7.0` | `0.7.2` | 2 |
| search-marketing | `0.4.0` | `0.5.0` | 1 |
| report-renderer | `0.0.0` | `0.1.0` | 1 |

> **Rule-1 debt, recorded not papered over:** the counter had to be derived from the *registry*,
> because the registry and this log have drifted. `platform-ui`'s newest entry here is `0.6.5`
> (2026-07-27) though the registry says `0.9.0`, and `reports` had no section at all until this cut
> opened one at `0.3.1`. The registry is the source of truth per the `infra 0.7.1` numbering note,
> so the derivation follows it. Back-filling the missing entries is outstanding work; inventing
> them from diffs would have been worse than admitting the gap.

**`Alpha 01.004.0006a` — SUPERSEDED, no image.** A concurrent session cut and pushed that tag at
`e901ab9` while this cut was being prepared. Its `release` run failed at
`build-sign (platform-nest)`:

```
src/main.ts(72,38): error TS2307: Cannot find module './modules/it/discovery.service'
```

`main.ts` was committed carrying an import of `discovery.service`, but that file was still
**untracked** in that seat's working tree — a commit referencing a file that was never committed.
`ci` failed on the same commit for the same reason. `deploy` was skipped, so nothing reached the
box. This is the **third** instance of the exact `001` post-mortem failure: snapshotting a tree
another seat is mid-write on. The number is burned, never reused.

Accordingly this cut was taken from **`9d65686`, the last commit with a green `ci`** — which
excludes only `e901ab9` (the knowledge two-tier RAG corpus, plus the half-committed IT-discovery
work). Nobody's uncommitted work was committed to unblock it.

**Full manifest** (all 19 registry rows, so this build is reconstructible):

| Module | Version | | Module | Version |
|---|---|---|---|---|
| platform-nest | `0.7.1` | | webdev | `0.8.1` |
| platform-ui | `0.9.0` | | webdesk | `0.0.0` |
| ai-gateway-go | `0.13.0` | | search-marketing | `0.5.0` |
| mcp-hub | `0.9.1` | | social-media | `0.0.0` |
| sync-engine-go | `0.7.0` | | creative | `0.1.0` |
| observability | `0.6.0` | | render-gateway-go | `0.0.0` |
| infra | `0.7.2` | | reports | `0.3.1` |
| wa-chat-bot | `0.9.1` | | report-renderer | `0.1.0` |
| ai-agents | `0.4.0` | | hermes-gateway | `0.2.0` |
| capture-helper | `0.2.0` | | | |

**Cut discipline.** Taken from a **frozen `git worktree`** (another seat held ~35 uncommitted files
throughout), and `platform-nest` was verified with **`tsc -p tsconfig.build.json`** — the exact
command the Dockerfile runs, and the exact command `01.004.0006a` died on — not `tsconfig.json`.

**Known-unverified at cut time:** `platform-nest`'s live-service suite passed 2560/2560 against real
Postgres/Cerbos/Redis on gda-aicenter, but the in-ERP recorder and the webdev server fixes came from
a concurrent session and were not independently re-driven here.

### `Alpha 01.004.0005a` — 2026-07-31 — trial branch merged back to main

The `trial/alpha-cut` line and `main` rejoin. `main` carried the search-marketing and reports work;
the branch carried everything that made the stack actually deployable and reachable. This cut is
the first that contains **both**.

Three module bumps (counter `0002 → 0005`, letter resets to `a`):

| Module | | Why |
|---|---|---|
| platform-nest | `0.7.0 → 0.7.1` | main's SEO/reports work **+** the branch's `GET /health` version field |
| platform-ui | `0.7.0 → 0.7.1` | main's Google/GSC/rankings/reports panels **+** the branch's SSO-only login and `PUBLIC_ORIGIN` redirect fix |
| infra | `0.6.0 → 0.7.0` | Hermes systemd units, the nginx public edge, GHCR runner auth, bind-mount sync, OIDC plumbing |

Nothing was dropped in the merge: the compose conflict was additive (the branch's OIDC block against
an untouched region on main) and the registry conflict was two sides bumping the same two rows.
Merged compose re-validated to the same 13 services.

**Superseded numbering note:** `0001a` and `0001b` were cut from `main` and produced no image;
`0002`/`0003` were cut from the branch and are what actually runs. The release counter never reuses
a number, so the sequence reads oddly on purpose — it is the honest record of what was attempted.

### `Alpha 01.003.0002a` — 2026-07-31 — SSO-only login page

One module bump (**platform-ui `0.6.5 → 0.6.6`**), so the module-reference counter moves to `0002`
and the revision letter resets to `a`.

The OIDC cutover left the login page showing the dev-login **email box as the primary action**,
with SSO as a secondary link underneath. Under `AUTH_MODE=oidc` that email path is disabled
server-side, so the most prominent control on the page was the one guaranteed to fail — reported
as "login is not working" when SSO itself was healthy throughout.

- `login/page.tsx` + `LoginForm.tsx` — under `AUTH_MODE=oidc`, render SSO alone and surface the
  `?error=` reasons the callback already emits (`sso` / `token` / `provision`), which previously
  went nowhere.
- `auth/callback/route.ts` — build redirects from `PUBLIC_ORIGIN` rather than `req.url`. Behind a
  proxy `req.url` resolves to the container's own bind address, so the callback sent authenticated
  users to `https://<container-id>:3005/`. An nginx `proxy_redirect` was papering over it; the app
  is now correct on its own and that rule becomes defence in depth instead of load-bearing.
- compose — `AUTH_MODE` and `PUBLIC_ORIGIN` passed to platform-ui; neither was set before.

### `Alpha 01.002.0001b` — 2026-07-31 — first deployable build

Cut to bring the trial stack up on **gda-aicenter** (the Hermes/DeepSeek box). Baseline manifest,
so the module-reference counter starts at `0001`.

| Module | Ver | Module | Ver |
|---|---|---|---|
| platform-nest | `0.6.4` ↑ | wa-chat-bot | `0.9.1` |
| platform-ui | `0.6.5` | ai-agents | `0.4.0` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` |
| mcp-hub | `0.9.0` | capture-helper | `0.2.0` |
| sync-engine-go | `0.7.0` | webdev | `0.8.1` |
| automation (n8n) | `0.4.0` | search-marketing | `0.2.0` |
| observability | `0.6.0` | infra | `0.6.0` ↑ |

- **infra `0.5.2 → 0.6.0`** — compose profile lanes (`data`/`bot`/`auth`/`multisite`/`whisper`) and
  the host-data overlay for gda-aicenter, where Postgres+pgvector, Redis and Ollama live on the
  host so other projects can share one cluster. `GATEWAY_TOPOLOGY_MODE` was hardcoded to `central`
  and silently ignored its env var — now honoured, with `GATEWAY_CENTRAL_URL`, which is the switch
  that routes all generation through the Hermes shim. `EMBED_CHAIN`/`OLLAMA_EMBED_MODEL` declared
  (previously absent) so embeddings resolve to nomic-embed-text at 768 dims, matching `vector(768)`.
  Deploy pipeline parameterized by compose file + profiles. Hermes systemd units added.
- **platform-nest `0.6.3 → 0.6.4`** — `GET /health` reports the app version.

**Why `002` and not `001`:** `001` was cut twice (`0001a`, `0001b`) and produced no deployable
image both times. The app release counter never reuses a number, so those attempts keep `001` and
this cut takes `002` — the history stays honest about what was tried.

**What this deliberately EXCLUDES:** the in-flight search-marketing (Google OAuth/GSC/GA4,
provider layer) and reports work, plus migrations `0053`–`0063`. Those seats were writing
continuously, and two cuts in a row captured a file mid-edit — a type error, then a syntax error.
Neither was a defect in their work; both were snapshot artifacts. That work lands as its own cut
once the seats are done, which is exactly what the versioning scheme is for.
### `Alpha 01.001.0001b` — 2026-07-31 — re-cut (build fixes)

Same module set as `0001a`, so the module-reference counter holds at `0001` and only the revision
letter moves — exactly the case the letter exists for. `0001a` never produced a deployable image.

Two failures in the `0001a` release run, both real:

- **platform-nest image failed to build.** `dataforseo.ts(247,42) TS2345: 'string | undefined' not
  assignable to 'string'`. `0001a` snapshotted that file mid-edit while the SEO seat was writing it;
  the seat fixed it moments later. Root cause on our side was the **verification gate**: the cut was
  checked with `tsc` against `tsconfig.json`, while the Dockerfile builds with `tsconfig.build.json`.
  Cuts are now verified with the build config, which is what CI actually runs.
- **SLSA provenance failed for all 8 components** — "Feature not available for user-owned private
  repositories." `actions/attest-build-provenance` needs a public repo or an org plan. Made
  non-blocking; the controls `deploy.yml` **enforces** (cosign keyless signature + attested SBOM)
  both succeeded. This is a genuine reduction in supply-chain assurance, not a formality — remove
  `continue-on-error` once the repo is org-owned.

Registry note: the SEO/tracker seats added `search-marketing` and `reports` to the registry during
this window, so the manifest below is now 20 modules rather than 14.

### `Alpha 01.001.0001a` — 2026-07-31 — first versioned build (SUPERSEDED, no image)

Baseline manifest. Cut to deploy the trial stack onto **gda-aicenter**, the new Hermes/DeepSeek
box, and the first app version to exist at all.

| Module | Ver | Module | Ver |
|---|---|---|---|
| platform-nest | `0.7.0` ↑ | wa-chat-bot | `0.9.1` |
| platform-ui | `0.7.0` ↑ | ai-agents | `0.4.0` |
| ai-gateway-go | `0.13.0` | hermes-gateway | `0.2.0` |
| mcp-hub | `0.9.1` ↑ | capture-helper | `0.2.0` |
| sync-engine-go | `0.7.0` | webdev | `0.8.1` |
| automation (n8n) | `0.4.1` ↑ | webdesk | `0.0.0` |
| observability | `0.6.0` | infra | `0.6.0` ↑ |

**Five module bumps** (↑). Because this is the baseline manifest the module-reference counter
starts at `0001` rather than `0005` — from here it advances by the number of bumps per release.

- **platform-nest `0.6.3 → 0.7.0`** — search-marketing provider layer (DataForSEO, Ahrefs, typed
  dispatch, cost ledger), Google OAuth + GSC/GA4 + search terms + SEM export, a new `reports`
  module with its Cerbos policy, PM task assignees/contributors, dept resolution, last-resort
  exception filter. Migrations `0053`–`0057`, `0060`–`0063`.
- **platform-ui `0.6.5 → 0.7.0`** — Google connections + GSC/GA4 panels, rankings panel, change
  proposals, paid-action gate, PM contributors.
- **mcp-hub `0.9.0 → 0.9.1`** — automation-policy tightening.
- **automation `0.4.0 → 0.4.1`** — SM n8n flows retired (superseded by the platform-side pull
  scheduler); env/README updated.
- **infra `0.5.2 → 0.6.0`** — compose profile lanes (`data`/`bot`/`auth`/`multisite`/`whisper`)
  and the host-data topology overlay for gda-aicenter; `GATEWAY_TOPOLOGY_MODE` un-hardcoded;
  `EMBED_CHAIN`/`OLLAMA_EMBED_MODEL` declared; deploy pipeline parameterized; `APP_VERSION`
  plumbed to `GET /health`.

**Verification at cut time:** platform-nest typecheck clean; platform-ui typecheck + 729 tests
green; mcp-hub typecheck + 106 tests green. platform-nest's suite needs live PG + Cerbos and was
not run locally — it runs in CI.

**Known caveat:** migrations `0058` and `0059` do not exist in the tree. If they surface later they
will apply *after* `0060`–`0062`, which the ledger orders by filename — check before they run
anywhere real.

---

## Program log — module additions

| Date | Event |
|---|---|
| 2026-08-13 | `social-media` **`0.2.0` -> `0.3.0` - SMM-08, the composer backend (DEV-VERIFIED).** Posts + per-network variants CRUD, the media-rule validation engine, quota pre-check, `args_sha256` maintenance, and the native-import path. **(a) The hash belongs to the estate, not this module:** `canonical-args.ts` reproduces the MCP hub's canonical-JSON algorithm and asserts the three fixed vectors the hub PUBLISHES for exactly this purpose, because that value is what a single-use approval grant is bound to - a one-byte drift between the two implementations fails every approved publish at the grant check, and the two services share no package by program rule. **(b) Edit invalidates approval, mechanically:** a content edit recomputes the hash, NULLs `approval_id` and drops `in_review`/`approved` back to `draft` in the SAME statement, so no window exists where an approval points at content nobody approved - proven end-to-end against a real `automation_approvals` row. **(c) Validation refuses what the network's API would refuse, before an approver is asked to sign off** (design D-12): per-network media/length/hashtag/settings rules plus the account's live quota, as pure functions shared by the composer, the submit gate and the dispatch re-check - one implementation, because a second copy is how 'valid at submit, invalid at dispatch' appears. Three judgement calls recorded in the code: caption length counts code POINTS (an emoji is one character to a human and to Instagram, but two to `.length` - counting units would have refused captions at half the real allowance); X's 280 is a SOFT limit that warns rather than blocks (premium tiers exist and the tier is invisible to us); and an unknown quota WARNS, never passes (`unknown` reading as `zero used` is how you confidently queue the 26th Instagram post of the day). The network always comes from the connector registry, never the request body, so a caller cannot claim a different network to dodge its rules; a post with anything live under it refuses deletion rather than orphaning something public. **Fixtures that the SCHEMA caught, worth recording because each was the constraint doing its job:** one publisher org per (tenant, client) (D-2's UNIQUE), a 6-char handle slice colliding because `newId()` is time-ordered, and `automation_approvals`' NOT NULL columns. 50 tests across three files (10 hash, 19 validation matrix, 21 endpoint golden cases); typecheck, both linters, MAP regenerated, BFF contract SS19 extended. Five MCP tools added; **`social.post.submit` and `.publish` remain deliberately UNDECLARED** - their endpoints do not exist until SMM-09 builds the D14 gate, and a tool the hub advertises without a handler behind it is frontend-first drift pointed at automation. |
| 2026-08-12 | `social-media` **`0.1.0` -> `0.2.0` — SMM-02, the module shell (DEV-VERIFIED).** `socialModule` is registered in `bootstrap()` (after 0106, because `validateModulePermissions()` refuses boot on an uncatalogued key) and `SocialController` serves `/api/:tenantId/modules/social`: engagements CRUD, the scope dial on its OWN endpoint and permission (`social.engagement.set_scope`, merged one level deep under `FOR UPDATE`), brand profiles (config + WS8 pointers only), campaigns (`kind` fixed `'organic'` — paid is a reserved seam, not a parameter), KPI targets, plus six rollup metrics. **This is the first department built TO the agentic-native bar rather than retrofitted onto it** — the plan named it as the last one that could be: 4 MCP tools sharing the HTTP surface's authorize() calls, snake_case refusal tokens, caller-supplied-uuid idempotency (a retried create answers `201 {created:false}`, not 409 — a retry is the point of the key), `setEngagementScope` impact-classified `medium` so an automation principal SUSPENDS into WS4 rather than moving the money dial unattended, and 14 golden cases driving every capability through the REAL endpoint with the three walls in place. **Two bugs its own tests caught before merge, both worth recording because both were silent:** (1) refusal tokens thrown as `{error: token}` were replaced by Nest's constructor-derived string and the sibling field dropped — `src/http-error.filter.ts` reads `message`, never `error`, and its own header documents the trap; (2) the brand-profile upsert coalesced against `EXCLUDED.tone`, which the INSERT arm had already defaulted to `'{}'`, so any partial patch silently ERASED the client's brand voice. Defaults enforce the owner decisions: every network OFF on a new engagement, `networks.x` false (keeping the publish path $0 and therefore eligible for the D14 executable-approval registry, whose doctrine permanently bars money-spending tools), `ai.imageGen` false and INERT — stored if enabled, but answered with a warning naming `image_generation_unavailable`, because the estate has no generative-image backend (gateway has `/complete`/`/media`/`/embed`; `render-gateway-go` is `0.0.0`). Docs moved in the same change: `FRONTEND-BFF-CONTRACT.md` §19 (backend-only, no `lib/social.ts` yet — stated explicitly, since frontend-first drift is this program's recurring bug class) and `docs/MAP.md` regenerated (new module + controller). Verified: 14/14 golden cases, `typecheck` clean, `lint:withtenants` + `lint:migration-rls` OK. **Still no publish path** — SMM-04 (Postiz containment) and SMM-05 onward own that, and the publish/inbox/report/ledger MCP tools are deliberately NOT declared until their endpoints exist. |
| 2026-08-12 | `social-media` **`0.0.0 PLANNED` -> `0.1.0 IN PROGRESS` — SMM-01 + SMM-30 landed (the P0 substrate).** Migration `0105`: the 16-table schema on TWO deliberately different RLS walls — 14 third-walled `social_*` tables, `social_platform_apps` global/no-RLS (our app fleet; zero client data, credential aliases only), and `social_post_client_reviews` on the PLAIN core tenant wall because the client portal writes it and portal controllers declare no module scope (0088's D-2a lesson applied before it could bite, not after). Structural state law on `social_post_variants`: past-drafting rows must carry both an approval and its `args_sha256` (the hub's canonical `argsSha256`, not a module-private hash); a `native_import` can never carry an approval or a provider id; `provider_post_id`/`approval_id`/`postiz_org_id` are each claimable exactly once. Migration `0106`: the IAM registration — 36 catalog permissions (35 `social.*` + `portal.approve_post`, a new action on the existing `portal` kind for the client half of the sign-off seam), 8 Cerbos policies, 9 permission groups, and the two module roles **`social_staff`/`social_manager`**. **The role names were a defect caught while building:** the design and the addendum both said `smm_*`, but `module_staff`/`module_manager` string-compose the name from the module key at request time, so `smm_*` would have seeded two roles nothing ever matches — the same silent-skip defect `0069`/`0091`/`0097` each closed for `reports_*`/`search_*`/`webdev_*`. Also found: SMM-03 is not a separate ticket (bundles are GENERATED from the policies and `role-bundle-completeness` requires non-empty bundles, so policies+roles must land together) — absorbed into SMM-30, with the UI capability mirror moved to SMM-11. Policies ship with the ROLE arm only; the `perm_social_*` mirror deliberately waits on PERMISSION-CONTRACT §2/§9's unresolved wildcard-bleed decision rather than widening the flagged surface by 8 fresh kinds for zero runtime effect. **Verified, not asserted:** all 106 migrations apply clean to a fresh DB; a scripted RLS suite proves the 14/1/1 wall split, zero rows without module scope, zero cross-tenant, zero on an unset GUC, the portal path still readable on the plain wall, and every state-law/idempotency CHECK refusing its bad case; `cerbos compile` clean; catalog<->policy alignment green both directions; groups<->catalog exhaustive coverage green; DB bundles == checked-in artifact; UI capability parity 548/548. Bundle diff: **861 -> 1023 pairs, 162 added, 0 REMOVED — no existing user's access changed.** Catalog 226->262 (211->247 grantable; the 15 relationship permissions deliberately UNCHANGED), groups 74->83, roles 20->22. Contract numbers updated in `docs/PERMISSION-CONTRACT.md` §2 in the same change. **No module code yet** — the ModuleContract shell, controllers and console are SMM-02 onward, and no user holds these roles until a `service_assignments` row for `module_key='social'` exists. |
| 2026-08-12 | `social-media` **design RE-BASED onto the current platform — still `0.0.0 PLANNED`, no code.** The v1.0 design (2026-07-23) was written against migration head `0033`, permissions-as-role-names and a broken D14 resume path; six of its load-bearing assumptions had expired. New binding addendum `docs/blueprints/smm-design-addendum-2026-08-12.md` (§A1 delta register with 16 verified platform changes, §A2 seven new decisions D-14…D-20, §A3 per-section amendments, §A4 the re-planned ticket set) — linked from `smm-design.md`, `BLUEPRINTS.md` and this registry. **What expired:** permission keys are catalog DATA (`social.engagement.read`, not `social:engagement:read`) behind six parity guards and a module-boot drift-guard, so a whole IAM-registration ticket (SMM-30 — catalog + groups + bundles + `smm_manager`/`smm_staff`) now precedes everything; D14 is CLOSED and its canonical single-use-grant contract (`x-approval-grant`, `argsSha256`, `lockKey`/`precondition`) replaces the design's bespoke `payload_hash`; the agentic-native 7-criterion bar is binding per capability (that plan names Social Media as the last department that can be built TO it rather than retrofitted); **no image-generation backend exists** (`ai-gateway-go` has `/complete`, `/media`, `/embed` only; `render-gateway-go` is `0.0.0`), so v1 is attach-only; the live client portal makes client post-approval real; migrations rebase `0034+` → `0105+`; the department is `social-media` (not `smm`) and inherits Home + the PM Work group + Connections, so only the "Publish" craft group is new UI. **Owner decisions 2026-08-12:** publish IS registered as an executable approval (so approving executes) with `networks.x` shipping disabled to keep that path $0 and clear of D14's permanent money-tool bar — a barred `social.publishPostMetered` twin carries X; client approval BUILDS in P2 on a plain-core-tenant-wall table (`social_post_client_reviews`, per 0088's D-2a lesson — a third wall reads zero rows silently for portal controllers); generative images decision-gated on the Creative render gateway. **Plan:** 30 tickets P0–P4 + 3 decision-gated (was 27 + 2), 7 opus flags (was 4); migrations `0105`/`0106` reserved. The print blueprint HTML/PDF are now STALE against this addendum (not regenerated). |
| 2026-08-05 | `mail` **MAIL-19 landed (senior-be) — quoted-history intake cap reshaped to head+tail (design A15), closing a real content-loss bug: a bottom-posted reply (below a long quoted thread) could be truncated away entirely by the old head-only 128 KiB cap, with no recovery possible since raw MIME is never stored.** `sanitizeInboundText` (`platform-nest/src/mail/inbound/html-sanitize.ts`) now keeps ~¾ head / ¼ tail of the same budget with an explicit `[truncated at intake: N characters omitted here]` marker spliced in at the boundary; `N` and the split are computed purely from length, never content, so a sender-forged decoy marker is stored back as inert ordinary text and can never mislabel or relocate the genuine one. `body_html_sanitized` unchanged (still head-only — splicing HTML mid-document would break the rebuilt-balanced-tags guarantee); no quote-boundary detection added (that's MAIL-20 render work); **no schema change, no migration** (the ledger is contended — `0078_automation_approval_execution.sql` landed from a concurrent session the same day). Three new corpus cases (`16-bottom-posted-oversize-quote` — THE regression, reply asserted present in `mail_messages.body_text` read back from Postgres; `17-top-posted-oversize-quote` — same profile, reply first, pins the reshape doesn't regress the case the old cap already handled; `18-elision-marker-spoof` — two forged decoy markers survive verbatim while exactly one genuine marker carries the correct count) plus five new unit tests; all 15 pre-existing corpus cases (incl. `07-oversized-body`'s unrelated whole-request 413 cap and `12-quoted-reply-bloat`, whose `_meta.expect` text was updated to note it sits under the internal cap) verified unchanged. `npx vitest run src/mail`: 15 files / 142 tests green (135 pre-existing + 7 new); `tsc --noEmit` clean under `src/mail` (three pre-existing errors in `src/core/d14-06-approval-decider-policy.test.ts` are concurrent APPR-01/D14 work, untouched by this ticket); A12 grep gate clean on every touched file incl. fixtures; test DBs run under a dedicated `TEST_DB_PREFIX`, all dropped after. Capped **IN PROGRESS** — no live-box replay leg in this ticket (deferred to batch B2, unaffected by the change since `fixtureNames()` picks the new cases up automatically). |
| 2026-08-04 | `webdev` **WD-23A-1 LANDED — the Google OAuth state machine is now CORE, unblocking the mail subsystem's Gmail ticket. `platform-nest 0.12.2 -> 0.13.0`, `webdev 0.10.0 -> 0.11.0`, `search-marketing 0.5.0 -> 0.5.1`.** Migration **0076** creates `google_oauth_states` and drops the module-local `search_google_oauth_states`; the state machine, token client, hosts helper and the OAuth-generic errors moved to `src/core/google-oauth/`, with the old paths as re-export shims so **no search call site and no probe assertion changed**. Renumbered from the staged `0070` after re-verifying the head — five migrations landed while it sat parked outside `migrations/` (parked deliberately: the runner executes the whole folder and this file DROPs the old table, so landing it early would have taken search's OAuth flow down until the code caught up). It also **unblocks MAIL-16**, whose ticket says "if still unlanded, STOP and escalate; never build a second state machine". 🔴 **THE DESIGN CORRECTION, and it failed loudly rather than silently:** the re-spec said the per-row `module` column replaces 0060's hard-coded `app_module_allowed('search')` and the `{modules:['search']}` option could therefore be dropped. Dropping it broke **every INSERT** with `new row violates row-level security policy` — because `app_module_allowed` reads the **request-declared `app.scopes` GUC**, not a company's enabled modules. The gate is a two-sided handshake: the row's `module` and the request's declared scope must MATCH. So a surface stamping `module:'search'` keeps declaring that scope on every read and write (which is what makes 0060's wall byte-equivalent), while a core surface stamps NULL and declares nothing. `consumeAuthorizationState` therefore takes `module` as an EXPECTATION — the row cannot be read at all without declaring the scope first, which is the point — and a wrong/absent module yields the same coarse `unknown_or_expired` as a forged state, so a caller cannot tell "exists but not mine" from "does not exist". One `moduleScope()` helper states the rule at all four call sites. Worth naming the asymmetry: getting this wrong the SAFE-LOOKING way — dropping `module` from the row — is silent and would have deleted search's third wall in a refactor; the loud failure is the one that happened. **A second consequence the types caught:** widening the provider union with `google_drive` made `isGoogleProvider` admit it, and search's two request-boundary validators used that guard while their error messages promised only search's three providers — they would have silently accepted Drive. New `isSearchGoogleProvider` guards both, search's provider-keyed records are keyed by `SearchGoogleProvider`, and the search adapter now **proves** a consumed row is a search row instead of assuming it. **A third: an egress-inventory row became a lie.** SM-39 listed `google/token-endpoint-client.ts` as approved outbound egress; after the move that path is a 4-line shim with no network call, so three of its assertions failed correctly. Deleting the row would have retired a security control during a refactor, so the guarantee MOVED with the code — new `core/google-oauth/egress.test.ts` pins the same two properties for core. That new test caught a defect in ITSELF on first run: its detector matched only `fetch(` while the token client does `const doFetch = fetchImpl ?? fetch`, so it reported ZERO egress in the one file that has it — passing its own allowlist while proving nothing. **Evidence:** Google suite **120 passed / 4 skipped both before and after** (identical to the recorded baseline); the **Keycloak oracle EXECUTED — 4 passed** (real auth-code+PKCE, refresh WITH rotation, RFC-7009 revocation), closing the AC that had been silently skipping; the new module-gate-both-ways suite **5 passed**, with a negative control (stamping `module: null` reds 3 of the 5, so the gate is load-bearing not decorative); `tsc` + both lint gates clean. The two probe files were edited ONLY as the amended AC permits — 8 + 6 table-identifier references, 14 lines, no assertion or expected value touched; neither names the state table's `client_id`/`property_id`, so no column edit was needed. **Still open (WD-23A-2, needs a real Google client / OQ-9):** the core callback controller at `api/integrations/google/callback` and webdev's Drive surface registration. Search's own callback is untouched and still serves its existing path. `VERSION` deliberately NOT bumped — other sessions are cutting tags rapidly and this rides the next one. |
| 2026-08-04 | `mail` **design REVISED to v2 the same day it was authored — the owner materially narrowed AND widened the scope; still `0.0.0` PLANNED, no code.** **CUT:** staff notification email is dead (notifications stay realtime in-app); the digest engine (old MAIL-07) and the per-user channel-prefs surface + `mail_notification_prefs` table (old MAIL-08) are **cancelled** — a required approval must reach its decider, so approval mail is not opt-out-able. The owner's 12:00/18:00 WITA cadence is the **WhatsApp/Telegram group rollup** (the bot's existing digest feature), not email — noted out of scope. **Triggers now attach to EXISTING classification, no new classifier:** mail fires only on (a) automation/AI medium+/unclassified writes — exactly the set the WS4 impact gate already suspends into `automation_approvals` — and (b) anything requiring human approval, routed to the resolved decider set (no per-approval decider column exists anywhere — confirmed; resolution mirrors the Cerbos DECIDE sets per origin: `company_admin`/`group_executive`, hr adds the providing unit's `hr_manager`, pipeline client gates use the existing `client-notify.ts` signer resolution — clients ride the SAME path, no separate stream). **D14-aware sequencing:** warning wording ships first for automation/agent origins (approving a suspended write executes NOTHING today — the mail must never imply execution); actionable wording for those origins is gated on the D14 resume path (Temporal decision, out of this program). **Link security locked:** approval mail carries a plain deep link behind SSO — no action buttons, no approve-by-reply, **never magic links** (magic links stay low-risk convenience login only, now an explicit non-goal). **WIDENED:** the module becomes **bidirectional** — inbound system-mail threads (`reply+<token>@notify.gaiada.com` VERP → new `mail_messages` global table, untrusted intake: signature+token auth, size caps, server-side sanitizer, ClamAV quarantine — MAIL-14 is ClamAV's first actual instantiation in the estate) + an ERP mail surface (`/admin/mail` sent-log UI + entity thread panels) + a **staging-ready staff Gmail read surface** (internal-type OAuth app ⇒ no CASA, employees only; per-user OAuth, NO domain-wide delegation; `gmail.readonly`; render-on-demand/cache-nothing so staging never mirrors real mail; tokens in the 0033 vault; state machine = WD-23A-1's staged core `google_oauth_states` — hard dependency, do not duplicate). **Domains locked (supersedes v1 Q1):** `auth.gaiada.com` + `notify.gaiada.com` (Workspace root) + `forms.gaiada.online` (Zone B only, off the employee-mail domain); **Google Workspace SMTP relay becomes Zone A primary** (free with seats, ~10k/day vs a handful/day of actual volume — the free-tier question is moot), Brevo = failover + inbound + Zone B forms; DNS guardrails: never touch root MX/root SPF, MX only on `notify.`, check `_dmarc` `sp=`. Both v1 findings preserved: approvals notify NOBODY on create (now also verified for `agency_approvals`), and NULL-tenant rows under FORCE-RLS are readable by nobody ⇒ mail tables stay GLOBAL. Ledger re-verified: head `0075` ⇒ mail core still `0076` (now incl. `mail_messages`); Gmail CHECK-widening at build-time next-unused (hint `0077`); `0058`/`0059`/`0070` untouched. Ticket plan re-cut: MAIL-01A/01B…MAIL-18 (07/08 dropped, numbers not reused), two Opus flags (MAIL-10 magic links, MAIL-13 inbound intake — both opus·medium). Blueprint `webdesk` → v1.2 (Zone B unaffected; Zone A provider/domain notes). Same docs, revised in place. |
| 2026-08-04 | `mail` **registered at `0.0.0` PLANNED — design only, no code; the ERP currently sends zero email** (no mail module in platform-nest, Alertmanager SMTP vars all empty, Keycloak realm has no `smtpServer`, provisioning sidesteps verification with `emailVerified:true`). New cross-cutting subsystem: [`../superpowers/specs/2026-08-04-zone-a-mail-design.md`](../superpowers/specs/2026-08-04-zone-a-mail-design.md) + ticket plan [`../superpowers/plans/2026-08-04-mail-subsystem-tickets.md`](../superpowers/plans/2026-08-04-mail-subsystem-tickets.md). Owner-locked shape: **sending only** (no mailboxes/IMAP); self-hosted service layer, **rented SMTP hop** (Brevo free tier → ZeptoMail/SES; Hostinger SMTP unpinned — shared-mailbox relay, low caps, can't send as arbitrary domains, VPS port block to verify); **three sending subdomains + three separate provider keys** (`forms.`/`notify.`/`auth.`) so form abuse can never rate-limit employee login mail; `From:` our domain + `Reply-To:` human default with per-tenant custom-domain upgrade; **Zone A mail never routes through webdesk C-03** (trust wall); portal email **digests by default** (immediate only for an approvals/mentions allowlist) riding the existing `notify()`/`notifications` surface; magic links designed now (single-use hashed tokens, always-202 enumeration resistance, `sealSession` coexistence with hybrid SSO+dev-login) but **built last behind a measured p95 delivery SLO** on the auth stream. Design found two real gaps while reading the code: creating an `automation_approvals` row notifies NOBODY today (MAIL-06 adds decider notifications), and NULL-tenant rows under the standard FORCE-RLS policy are readable by nobody at all (owner is NOBYPASSRLS) — which forces the mail tables global (design §6.1). Migration verified against the live ledger: head `0075`, `0058`/`0059`/`0070` claimed/dead ⇒ mail core takes **`0076`** (re-verify at DDL time per README rule 5). 12 tickets MAIL-01…12, one Opus flag (MAIL-10 magic links, opus·medium), blocked at W0 on owner Q1 (subdomain root) + Q2 (provider signup). **Same session: `webdesk` blueprint amended to v1.1** (C-02 recipient-config note, C-03 provider path + reputation split + Zone A separation, new D14, portability row) — HTML only; PDF + hosted artifact not re-rendered. |
| 2026-08-04 | `webdev` **The last four department gaps closed: B2, B6, C1 and the missing demo client. `platform-nest 0.11.0 -> 0.11.1`, `platform-ui 0.13.0 -> 0.14.0`.** **C1** — `GET /pipeline/runs` now accepts `clientId`/`projectId`, so `/pipeline` narrows **server-side**; it previously fetched the 200-row cap and hid rows in the browser, which stops being a filter past 200 runs. Ids compare as **text**, so a hand-edited query string matches nothing instead of 500ing on a uuid cast. The page also stops reconstructing the client from the recordings registry — C4 made the list carry `client_id`, so a run with **no meeting** now shows its client too, and the teach-state that blamed "the list doesn't carry a client id" is corrected to say what a blank now actually means: the run really has no client and will never appear in a portal. **B2** — start a delivery run with no source meeting. Real work does not always begin with a recorded call, and the only prior workaround was fabricating a meeting, which corrupts the capture registry to satisfy a UI limit. `sourceMeetingId` stays **null** deliberately: that is what marks the run human-originated, and it is the dispatcher's dedupe key, so inventing one could collide with a later real ingest. The form REQUIRES a client even though the API permits null — a clientless run can never reach a portal, so creating one here would silently produce invisible work. **B6** — `relink-orphans` was API-only, so recovering meant curling production; now a button, safe to expose because the sweep is idempotent, and it reports **"Nothing to repair"** rather than a silent success. Both live in a collapsed "Recovery tools" panel, worded as recovery: putting "start a run by hand" beside the everyday controls would invite bypassing capture, which is where the transcript, MOM and artifacts all come from. **The demo client identity — the portal was the ONE shipped surface with no demo identity at all**, so `/portal` could not be browsed backend-free even though `DEMO_MODE=1 next build` and the Playwright smoke project both run that way. New `demo-client` (Northwind Traders, the client that actually owns `run-demo-1` — naming it after a different client would show "your projects" for a company the person has nothing to do with) holding **only** the `client` role, plus `portalDemo` served from the SAME runs/stages/gates the staff surface uses, because two fixture sets would let the demo show a client a different reality from the run workspace. It **403s a staff user** exactly as the real BFF does — without that the staff teach-state would be unreachable dead code — filters the internal `report` track in the FIXTURE (where the real BFF filters it, so the guarantee is not vacuous), and 404s another client's run indistinguishably from a nonexistent one. **The dev-login tier resolver moved to `lib/demoIdentity.ts` and got tests, because I had documented ordering as "pinned" when nothing pinned it:** `actions.ts` is `"use server"` and may export only async functions, so the pure helper could not live there. The client test must run BEFORE the IC test — "ic" is an extremely common substring in real names (`erica@`, `nicole@`), and getting the order wrong hands external clients the staff dashboard. **23 new tests** (4 backend filter cases incl. the malformed-id and the exclusion assertion; 13 demo-fixture cases incl. "an unknown clientId returns nothing rather than everything", the failure mode indistinguishable from working; 5 tier-ordering cases; relink idempotency). platform-ui **997/997 across 100 files**, `tsc` + `DEMO_MODE=1 next build` + both nest lint gates clean. ⚠️ The nest DB suites did not run locally (Docker Desktop is down on this machine) — CI executes them on push, as it did for the seed. Docs updated per this repo's own rules: `platform-ui/CLAUDE.md` (tiers, identities, `isClientOnly`) and `FRONTEND-BFF-CONTRACT.md` (C1/B2/B6 + C3/C5 deltas). |
| 2026-08-04 | `webdev` **5 seeded clients across 2 companies VERIFIED live, and a client-routing bug fixed on the way. `platform-ui 0.12.0 -> 0.13.0`.** `seed:portal-clients` ran on gda-aicenter and provisioned 7 Keycloak accounts; each of 6 contacts was then **logged in for real via PKCE** and asserted: sees exactly their OWN run (the exact expected title, so neither a leak nor a broken link passes), sees **only their own company** — the two Sanur Resort contacts see no trace of the agency, which is cross-company isolation shown rather than claimed — gets **403** on `/clients` and `/meetings/recordings`, and gets `['delivery','scope']` from the run detail with the internal **`report` track absent every time**. `ALL CHECKS PASSED`. ⚠️ **My first verification run reported two failures that were my own assertion's fault, not the product's:** it matched the client's first word against the run title, and "Bali Wedding Planners" owns "Wedding microsite" while "Sanur Dive Center" owns "Dive Center". A substring heuristic is not an isolation assertion; it now compares against the exact expected run per contact. 🔴 **THE BUG THE SEED EXPOSED — a client-only user had nowhere to land, and fixing that uncovered a worse one already shipped:** nothing outside `navFor` consulted client-ness, so a client logging in landed on the staff **My Work** dashboard (every read 403-degrading) and had to find "Project Portal" in the sidebar. Adding the redirect surfaced that `navFor`'s guard, `isClient && !isElevated`, is **wrong**: `isElevated` is only global `platform_admin`/`group_executive`, so a **manager or company_admin who is also a client contact** matched it and was already being handed portal-only navigation — losing the entire staff surface. The redirect would have escalated that to locking them out of the app. A PM added as a contact on their own client is ordinary, so this was reachable. New `isStaff` / `isClientOnly` in `rbac.ts` ("any role that is not `client`", so a role added later counts as staff by default and fails toward KEEPING someone's workspace), used by both call sites. 6 new rbac tests pin it, including the manager-who-is-a-client case and an explicit `isElevated(both) === false` to record exactly why the old guard misfired. **The seed itself:** deliberately uneven — a viewer-only client (so "nobody here can sign" is visible), a client with nothing pending, a `complete` run, and a provider signature pre-placed on scope runs so the client's signature is the last one needed. Its **10 tests executed in CI** against real Postgres (Docker Desktop was down locally, so this is where they ran). platform-ui **979/979**, `tsc` + `DEMO_MODE=1 next build` clean. |
| 2026-08-04 | `webdev` **Portal demo seed — clients across several companies, each with a real login. `seed:portal-clients`.** The portal was provably correct with nothing to look at: one client, one company, and (before WD-30) runs that carried no client. This seeds the shape the real thing has — a holding whose member companies each serve their own clients — so the portal can be exercised as five different people and the tenant boundary can be SEEN rather than asserted. Per client it creates the `clients` row on **that client's own company**, a project with `client_id` set, contacts, the global `client` role granted at that company (without which a contact resolves a tenant and is then denied everything), and a `pipeline_run` carrying **both** `client_id` and `project_id`, with real PRD/Scope artifacts and — on some runs — a PENDING client gate so "N things need you" is a real state. **Deliberately uneven, because a fixture that is uniformly happy has not been reviewed:** one client has two contacts, one has only a **viewer** (so "nobody here can sign" is a state you can actually see, and the staff-side warning fires), one has nothing pending (so "Nothing needed from you right now" is exercised), and one run is already `complete`. Every run also gets an internal-only `report` stage — seeded precisely so "the client cannot see the report track" is testable instead of vacuously true. Scope runs carry a **provider** signature already, so the client's own signature is the last one needed and `complete: true` is reachable in one click from the portal. **Keycloak is optional and fail-soft, but not fail-dishonest:** configured, it provisions each account and sets one documented password so contacts are `active` and can log in immediately; absent, contacts stay `invited` and the seed prints real single-use invite links — marking them `active` would claim a login that does not exist. A company it cannot find is **skipped and reported**, never created: inventing a member company would produce a tenant with no org structure, people or modules, which reads as corrupt data rather than a missing seed step. Idempotent throughout, and it re-asserts `client_id`/`project_id` on rows an earlier seed left unlinked. **10 tests** that EXECUTE the seed against real Postgres rather than reading its INSERTs (the standard `agency.db.test.ts` set after three seed bugs `tsc` could not see): clients land on BOTH companies, every run carries both links, each run's project agrees with the run about who the client is, the role is scoped to the right company, signer and viewer are distinguishable, the hidden report stage exists, contacts stay `invited` without Keycloak, and a second full run duplicates nothing (by row count). ⚠️ `tsc` is clean but **those tests have not been executed yet** — Docker Desktop went down on this machine, so the DB suite could not run locally; CI runs it on push and the live seed run is the other half of the evidence. |
| 2026-08-04 | `webdev` **WD-30 PROVEN LIVE, and C4/C6 closed. `alpha-01.010.0029a` deployed.** The portal now returns **real data** to a real client: an invited contact on Bali Beach Resort logged in through the actual PKCE flow and `/portal/runs` answered with their runs — titles, `"Waiting for your signature on the Scope Agreement"`, and `pendingActions: 1` — while `/clients` and `/meetings/recordings` stayed **403**. That is the assertion the earlier walk could not make: it got a 200 carrying `[]`. Migration **0074** attached the 2 runs whose meetings had a client and correctly left `Dispatcher latency probe` NULL, whose meeting had none — it never invents an attachment. ⚠️ **A probe of my own misreported this first.** Step 0 of the proof read `/api/:t/pipeline/runs` and reported "0 of 5 runs now carry a client_id", which would have meant the backfill silently no-opped — the exact 0050 signature I had written 0074 to avoid. It was the probe that was wrong: the LIST select omitted `client_id` entirely, so every row's field was absent and read as null. A missing FIELD and a null VALUE are indistinguishable in JSON, and the run DETAIL endpoint showed the real client ids immediately. Worth recording because the failure mode is invisible: a 200 with a field the caller expects and the server never sends looks exactly like data that is not there. **C4/C6 (that same omission, now fixed):** the list SELECT carries `client_id`, `project_id` and `owner_id`, so the pipeline list can show whose work a run is without cross-referencing the recordings registry, and the run workspace links straight to its project. C6 had been filed as blocked by the absent `project_id` column — W0 added it, WD-30 populates it, so it was only ever waiting on those. UI types mark the new fields OPTIONAL on the list so a server on an older tag renders no link rather than an empty one. **Two stale teach-states corrected:** the run workspace warned "the n8n dispatcher currently drops client context on ingest" as a known gap; that is what WD-30 fixed, so it now explains the one case that legitimately remains (a run created directly, with no source meeting). **Deploy verification:** the new retention step ran and the box holds exactly two tags (this one plus the rollback target), disk steady at 71%; `Prune superseded images` and `Record deployed tag` both succeeded and `Roll back on failure` was **skipped** — the first deploy since the rollback was re-gated on health. platform-nest pipeline+portal+meetings **84/84**, platform-ui **974/974**, `tsc` + `DEMO_MODE=1 next build` clean. **Known gap, stated rather than papered over:** there is no `client` demo identity, so `/portal` and `/portal/[runId]` cannot be browsed in DEMO_MODE at all — adding one means new login tiers, a `/me` fixture and an rbac change, which is wider than this pass. Automated invite email also remains unbuilt (no mail transport in the estate). |
| 2026-08-04 | `webdev` **WD-30 + C3 + C5 — the client portal could never have shown a client anything, and the login hop is now driven for real. `platform-nest 0.10.0 -> 0.11.0`, `platform-ui 0.11.0 -> 0.12.0`.** **THE LOGIN GAP IS CLOSED, not worked around.** `gaiada-ui` is a public PKCE client with direct access grants disabled, so the previous entry recorded the browser hop as undriven. Rather than weaken a production auth client to make it scriptable, the real authorization-code + PKCE flow was driven end to end — authorize, POST Keycloak's own login form, capture `code` from the 302 without following it to the callback, exchange with the verifier. The invited contact **logged in**, and the token was accepted by the platform. `/api/companies` returning the tenant is the load-bearing part: it proves `provisionUser()` linked the first login (so `emailVerified: true` at accept did its job) AND that principal.ts's `client_contacts` union granted the tenant — without either, that call is empty or 401. Then an ALLOW and two DENYs from one token: `/portal/runs` **200**, `/clients` **403 cerbos denied**, `/meetings/recordings` **403**. 🔴 **WD-30, and it is the real reason the portal showed nothing:** every `pipeline_run` on the server had `client_id NULL` — 5 of 5, verified. `createRun` has always ACCEPTED `clientId`; the n8n extraction flow has never sent one. `/portal/runs` filters by the caller's client ids, so a contact who was correctly invited, provisioned, role-granted, tenant-ed and Cerbos-allowed still got `[]`. Every layer reported success and the portal was structurally blind — the W0 fix that made the portal *authorize* correctly could never have made it *show* anything. `createRun` now derives client/project from the source meeting when the caller omits them (explicit body value still wins), derived server-side rather than by editing the workflow because an n8n artifact can be re-imported and a contract this load-bearing must not depend on every caller remembering. Migration **0074** repairs the 4 historical runs that resolve to a client, written as a per-tenant `set_config` loop: a bare UPDATE would have matched ZERO rows under FORCE RLS as `platform_owner` (no BYPASSRLS, GUC unset), reported success, and left the portal just as blind while looking fixed — the confirmed 0050 class. **C3 (N+1):** the list computed each run's blockage with two queries per run — 201 round trips on a full page, on the one surface whose latency is paid by someone outside the company — now two batched queries grouped in memory, plus a free `pendingActions` count. **C5:** `getPortalRun` and `PortalRunDetail` already existed and NOTHING rendered them; the list page fetched every run's detail (1+N HTTP calls, four queries each) and inlined it, so a client could not open a single project and the reader was dead code. New `/portal/[runId]` reads documents OUTSIDE a signature prompt (a client could previously only ever see an artifact while being asked to sign it, never re-read what they had agreed to) and shows BOTH scope parties, since hiding the provider side lets a client think an agreement is settled while it waits on us. Gate actions extracted to `PortalGateActions` so the D-3 guarantee — what the client sees is what they sign — has one implementation, and a sign button with no artifact is now disabled with a reason rather than presented bare. **8 new tests, each shown red against the PLAUSIBLE defect, not a syntactic deletion:** reverting the derivation to `clientId ?? null` reds exactly the 2 inheritance tests while the 3 controls (explicit wins, null stays null, no-meeting) stay green — which is what makes them controls; dropping `?? []` from the batch grouping reds the empty-run and gate-count tests, the case a brand-new run hits most. platform-nest **2753 passed / 4 skipped / 0 failed** before the portal work, portal+pipeline **48/48** after; platform-ui **949/949**, `tsc` + `next build` (`/portal/[runId]` present) + both lint gates clean. **Two stale header comments corrected from verified behaviour** rather than left to mislead: portal.controller.ts and lib/portal.ts both described an external client Keycloak realm and `portal_user_id` linkage that was never built. **Still true:** `hasAccount` tracks `idp_subject` ("has linked"), so its name still misleads; automated invite email remains unbuilt (no mail transport in the estate). |
| 2026-08-03 | `webdev` **W0+W1 largely DEV-VERIFIED on gda-aicenter (module row stays IN PROGRESS: client LOGIN is the one hop still undriven) — `alpha-01.009.0028a` is deployed and the invite -> accept -> provision -> schedule -> participants chain was driven against it.** Live results, each with its HTTP status recorded because a 200 carrying `[]` is not a pass: contact create **201** (Cerbos manager tier, D-2), a **146-char** invite token accepted **200** (the length that used to 404 at find-my-way's `maxParamLength`, now in the body), the same token replayed **400** (single-use holds), the contact moved `invited -> active` with an `activated_at`, and a **real Keycloak account** exists for it — read back through the provisioner admin API as `enabled: true`, `emailVerified: true`, no pending required actions. Scheduling returned **201** with a minted `meeting_id` and the `?scheduled=upcoming` filter returned it as `scheduled`. Participant add sent `side:"internal"` **deliberately** and the API answered `side: "client"` — derivation beats the body, live, not just in tests. **Two design properties confirmed by observation rather than assertion:** the contact is ABSENT from `GET /api/:t/users`, which is the whole point of not giving client contacts a `company_memberships` row (they cannot leak into staff listings), and `hasAccount: false` after a successful accept is CORRECT — it tracks `users.idp_subject`, which `provisionUser()` sets at first login, so the field means "has linked" not "an account exists". The name is misleading and is worth renaming; the behaviour is right. **THE GAP THE WALK FOUND, invisible to every test and to `docker compose config`:** `INTEGRATION_TOKEN_KEY` was never forwarded to the platform container. A 43-char value sat in `.env` while the container read `""`, and that key signs W0 invite tokens, signs SEO's Google OAuth state tokens, and is what `secret-box.ts` encrypts stored integration secrets with — so **three shipped features could never have worked in production**. It surfaced as a typed **503** naming the variable (`ClientAccessErrorFilter` doing its job instead of a 500), which is what made it a five-minute diagnosis instead of a hunt. Now forwarded in `docker-compose.vps.yml`, deliberately without `:?` so absence stays a specific runtime refusal rather than blocking the whole stack from starting. **NOT driven, and the limit is specific:** the browser login hop. `gaiada-ui` is a public PKCE client with direct access grants disabled — the correct posture — so a user token cannot be minted headlessly, and weakening a production auth client to script a test is not a trade worth making. Everything the ERP controls is verified; the Keycloak redirect itself is not. The `client` role grant is likewise test-covered but not live-observed, because the endpoint that would show it deliberately excludes client contacts. |
| 2026-08-03 | `infra` **The deploy could fill the disk and then revert a healthy release. `0.7.4` -> `0.8.0`.** Deploying `alpha-01.009.0028a` exposed both halves. Nothing pruned release images: nine per deploy, none removed, eleven tags resident, `report-renderer` ~3.6GB each — the 49GB disk hit **100% with zero bytes free**, and `docker image prune -f` reclaims **0B** because the images are tagged rather than dangling, so only an explicit `docker rmi` per tag frees anything. Then the sharper fault: `Record deployed tag` is a single `echo` into a file, it failed for want of one byte, and `Roll back on failure` was gated on bare `failure()` — which fires for ANY earlier step. **`Start services` and `Wait for health` had both already passed**, so a bookkeeping write reverted a working release and `/health` then reported the old version, reading exactly like a deploy that never happened. Rollback is now gated on `steps.health.outcome != 'success'`; a skipped health step is also not `success`, so genuine failures still roll back. New retention step keeps this tag plus `steps.prev.outputs.tag` — the previous tag IS the rollback target, and pruning it would convert a bad deploy into an outage — and is `continue-on-error`, because housekeeping must never fail a healthy deploy, which is the very bug being fixed. Also caught before it bit: `COMPOSE_PROFILES` was `bot,auth` while `whisper` sits behind `profiles: [whisper]` and had been started by hand, so `up -d --remove-orphans` would have **deleted** it and killed the transcription chain; the variable is now `bot,auth,whisper`. n8n was never at risk — it runs in a separate compose project — which is worth stating because "n8n always survives deploys" is not evidence that a hand-started container will. 14GB reclaimed by hand, all 15 services verified healthy afterwards, and the server `.env` re-synced (its `GAIADA_TAG`/`APP_VERSION` had gone stale again, and `APP_VERSION` was unquoted so sourcing the file errored). |
| 2026-08-03 | `release` **Merged `origin/main` (14 commits) and cut `Alpha 01.009.0028a`.** Both lines had bumped module versions independently, so the table is rebased on main's numbers (which carry other sessions' work) and only this wave's modules are bumped on top: `platform-nest 0.9.5 -> 0.10.0` (migration 0072, client contacts/invites/Keycloak provisioning, scheduling, client notify), `platform-ui 0.10.4 -> 0.11.0` (recorder, invite accept page, contacts + scheduling + participants panels), `mcp-hub 0.9.2 -> 0.9.3` (`pipeline.runBySourceMeeting`). Main's `infra 0.7.4` / `wa-chat-bot` / `ai-agents` dates are kept untouched — taking this branch's older rows would have silently reverted them. Two content conflicts were resolved to **main's** side after checking which was newer: `knowledge/ingest/erp-source.ts` and its README, because main carries `741ad4e fix(knowledge): index pm_tasks` that this branch predates, so keeping ours would have reverted that fix. |
| 2026-08-03 | `webdev` **W1 — scheduling, participants, client notifications, pipeline lifecycle UI. `webdev 0.9.0` -> `0.10.0`, `platform-ui 0.10.0` -> `0.11.0`.** Makes D-3 walkable: a PM can now invite client contacts, schedule the meeting, and set who attends on both sides — all before anyone presses record. The client page reads in setup order (Client access -> Scheduled -> Meetings), which is the reframe rather than decoration. **Scheduling** (`POST .../recordings/schedule`, participants add/remove, `?scheduled=upcoming`) over migration 0072's columns, no DDL. `meeting_id` is minted through a shared `mintMeetingId()` that `start` also calls, so the two paths cannot drift — that id is the frozen dispatcher dedupe key. The hardcoded `STATUSES` set disagreed with the 0072 CHECK and is widened. `side` is derived server-side and never taken from the body, proven by tests that send the OPPOSITE side and assert the derivation wins. **Corrected the agent's `side` derivation**, which gated `client` on `status='active'`: a `client_contacts` row IS a PM's assertion of which side someone is on, while `status` answers whether they can log in yet. Gating on active mislabels a client as internal staff in exactly the pre-acceptance window D-3 exists for — and `internal` is the MORE privileged label, so an active-only check is conservative about naming and permissive about exposure. Now derived from presence; `revoked` still reads `client` because the column is denormalised so a historical attendee list stays truthful. **Client notifications** on four write paths (client gate opens, client decides, scope.signed completes) through one exported resolver: active-only, client-wide-or-matching-project, and signature requests restricted to `signer` contacts since a viewer asked to sign cannot act. Per-recipient try/catch, so a notify failure can never roll back a transition — asserted by forcing one. 🔴 **THE GAP THAT MADE W0 INERT, and no existing test could catch it:** `PortalController` resolved clients ONLY via the legacy `clients.portal_user_id`, which the invite flow never writes. A contact could accept, get a Keycloak account, receive the `client` role, gain the tenant via principal.ts's union, pass `resource_portal` authz — and then be refused with "not a portal client". Every step upstream reported success and the portal showed nothing. The W0 spec said the portal "resolves through this table instead"; that intent was never implemented, and the previous CHANGELOG entry's claim that W0 closed this root was overstated. Now resolves a SET of clients (D-1 made contacts many-per-client) from active `client_contacts` UNIONed with the legacy column — unioned, not replaced, since that column has live rows and its own tests. Project scoping is now enforced, and a client-wide row WIDENS access so adding a narrower row cannot take access away. 9 tests, all on the invite-flow configuration (no `portal_user_id`, no staff membership) that `portal.test.ts` never exercises. 🔴 **A defect the previous entry itself created and misreported:** `scope-signoffs` checked `party` only for truthiness, so the server walk's `party:"agency"` was stored and answered `complete:false` — indistinguishable from a correct "waiting on the client", which is how it was reported. "agency" satisfies neither entry of `REQUIRED_SCOPE_PARTIES ["provider","client"]`, so that run could never complete, and the unique index on `(run_id, party)` means the junk row permanently occupies a slot. Now validated with a 400. Found by an agent that read the live Cerbos policy instead of trusting the gap-assessment doc. 🟠 **`pipeline_runs.owner_id` was unwritable** — `createRun` never accepted it and `updateRun` took only `status`, so the column 0072 added was permanently NULL and every "notify the owner, else created_by" resolved to `created_by`. A column no code can set is indistinguishable from one that does not exist. Now settable on create and PATCH; `ownerId:null` clears it while omitting the key leaves it untouched (a `CASE` on key-presence, not a `COALESCE`, so a status-only park cannot silently unassign the PM). The owner must be ACTIVE STAFF, never a client contact, because `owner_id` is who INTERNAL notifications address. **UI:** agency scope sign-off (gap B1 — without it no scope agreement could complete from either side), run lifecycle recovery tools (collapsed and warning-toned, not beside routine controls), `/pipeline` and `/meetings` filters, and a client column resolved WITHOUT an API change or invented data (cross-referencing `source_meeting_id` against the recordings registry, showing "—" where a run has no traceable meeting). Scheduling surfaces two states a PM would otherwise learn too late: a scheduled time that passed while still `scheduled` ("Time passed — not recorded" — the capture never happened) and a client meeting with nobody from the client side attending. **An existing registration pin caught a 6th global filter** and was updated deliberately, as its own message demands — `LastResortExceptionFilter` stays FIRST because Nest reverses the argument list, pinned independently. **Timezone assumption stated, not left implicit:** `datetime-local` is zone-less and conversion happens server-side, so the platform and the PM are assumed to share a timezone; a multi-timezone agency needs an explicit offset, which is a contract change. Suites: platform-nest **2739 passed / 4 skipped / 0 failed** (full sweep), platform-ui **943/943**, `tsc` + `next build` + `lint:withtenants` + `lint:migration-rls` clean, both service images build. Cerbos `resource_client_contact` is DEPLOYED and proven live on gda-aicenter with both an allow and a deny. **Still PROTOTYPED:** the running server image predates all of this, so the live invite->accept->login and schedule->record walks have not been driven. **Known remaining:** the portal's N+1 and missing `/portal/[runId]` detail (C3/C5), run<->project navigation (C6), and automated invite email (W0 ships copy-the-link deliberately — there is no mail transport in this estate). |
| 2026-08-03 | `webdev` **W0 — client engagement setup: contacts, magic-link invites, Keycloak provisioning, scheduling schema. `platform-ui 0.9.0` -> `0.10.0`, `webdev 0.8.1` -> `0.9.0`.** Closes the two structural roots the gap assessment found: `pipeline_runs` had no `project_id` (a recording started from a project workspace knew its project and the run it produced forgot it — the reason WD-06 needed a one-project-per-tenant env var), and `clients.portal_user_id` was written **only in test fixtures**, so the client half of every gate could never be countersigned in production. **Migration 0072:** `client_contacts` (many per client, `project_id NULL` = client-wide per D-1, signer/viewer capability because "on the same page" implies contacts who watch but must not sign, two partial uniques because UNIQUE treats NULLs as distinct), `client_invites`, `meeting_participants`, `pipeline_runs.project_id`/`owner_id`, scheduling on `meeting_recordings` (new `scheduled` status; rides the existing registry rather than a parallel calendar because that registry already mints the `meeting_id` the frozen dispatcher contract keys on), and the global **`client` role, which had never been seeded** despite two policies depending on it. **Design correction found by audit:** client contacts deliberately do NOT get a `company_memberships` row. Only 6 of 27 non-test queries over that table filter `kind`, so widening it would have needed a defensive filter at ~10 staff-listing sites and left every future site free to forget — a client contact appearing in `/people` and HR as an employee. Instead `rbac/principal.ts` unions `client_contacts` into `principal.companies` and `notify()` accepts them: two deliberate edits instead of ten defensive ones, and the leak becomes structurally impossible. Safe because of a VERIFIED property — `"user"`, the parent of the `client` derived role, is granted by **no** policy, and `derivedRoles: ["client"]` appears only in `resource_portal.yaml`. **`notify()` was silently dropping every client notification** (memberships-only check with a bare `return`) — exactly the failure D-3 exists to prevent, in its least detectable form. **Keycloak:** the platform's first Admin API integration. Real `gaiada-provisioner` service-account client created on the `gaiada` realm (manage-users + view-users only; boundary probed — creating a client 403, mapping `realm-admin` onto its own created user 403 and verifiably not sticking), then `keycloak-admin.ts` driven against the LIVE realm over HTTPS: create with `emailVerified:true` -> read-back -> setPassword -> disable -> enable -> exact-match guard -> cleanup. That flag is load-bearing: `provisionUser()` **throws** on a first login whose invited email is not IdP-verified, so A (provision) and C (magic link) are two halves of one flow, not alternatives — the clicked token is what makes the flag honest. Revocation DISABLES rather than deletes (the audit trail must survive; deleting the IdP identity orphans `idp_subject` so a re-invite could mint a second account) and only when it was the contact's LAST active engagement. **Invite token** reuses the shape and reasoning of the estate's Google OAuth state token, with its own published attack list: forgery/tenant-pivot (HMAC over both ids, compared before any DB read and over a CANONICAL re-encoding), replay (one atomic `UPDATE ... WHERE consumed_at IS NULL RETURNING`), wrong-address redemption (email bound at issue), leaked-DB redemption (only sha256 stored), indefinite validity (72h enforced INSIDE the consume predicate), cross-tenant read (FORCE RLS + the signed tenant being the only tenant opened). The tenant travels in the TOKEN, not the row: the accept route is tenant-agnostic and the table is FORCE-RLS, so reading the row to learn its own tenant is circular. **Three bugs caught by tests rather than inspection, all invisible to `tsc`:** (1) the accept route was **unreachable for every invite ever minted** — a real token is 146 chars and find-my-way's `maxParamLength` defaults to 100, so it 404'd at the raw router before Nest; fixed by moving the token into the request BODY rather than raising the ceiling, which also keeps a bearer-equivalent secret out of access/proxy logs, `Referer` and browser history. (2) `KeycloakNotConfiguredError` **and** `ClientInviteError` both extend `Error`, so every typed refusal surfaced as a generic 500 discarding `.status`/`.code`/`.missing` — a doc comment had asserted a filter that did not exist; new `ClientAccessErrorFilter` covers both (fifth instance of this bug class here). (3) a `"use server"` module may export only async functions, and a client component may `import type` from a server-only module but not value-import from it — two module splits `tsc` and vitest accept while `next build` rejects. **Cerbos:** new `resource_client_contact` (create/update/revoke at manager tier per D-2 so the PM who owns the engagement acts without an admin; `group_executive` gets its OWN rule gated on `notLow` only, never `inTenant`, per WD-20-R1), and `scope_signoff.create` widened to `manager` — a deliberate scope change, not a fix for the correct 403 a manager-tier automation account hit during the server walk. `team_lead` documented as a DEAD TIER on this kind (it needs a team-scoped grant matching `resource.teamId`, which client contacts have no concept of). **Deployed and proven live on gda-aicenter** (policies are bind-mounted server files): manager ALLOW / member DENY on create, and an exec who is a member of NO tenant still allowed — both an allow and a deny, because an unlisted kind is a silent DENY that reads like a logic bug. **UI:** public `/invite/[token]` page (middleware allowlist) that deliberately does not pre-validate the token — single-use means a check would spend it, and distinguishing valid from invalid would be the exact oracle the coarse API refusal denies — plus `ClientContactsPanel` on the client page, above Meetings because setup precedes capture. It surfaces "link not used yet" as a normal waiting state and warns when no contact can sign off, since a scope agreement would otherwise wait indefinitely. The invite link is shown ONCE and says so, because the API keeps only a hash. Suites: platform-nest **92/92** across the five W0 suites (invite tokens 19, contacts 14, keycloak-admin 18, Cerbos matrix 26, HTTP 17) plus meetings 30 and pipeline/race 32; mcp-hub 32; platform-ui **939/939**; `tsc` + `next build` + `lint:withtenants` + `lint:migration-rls` clean; both service images build. **Still PROTOTYPED, not DEV-VERIFIED:** the running server image predates this code, so the live invite->accept->login walk has not been driven; the server env, Cerbos policies and provisioner client are pre-staged and verified so a tag rollout should light it up. |
| 2026-08-03 | `platform-ui` `0.8.0` → `0.9.0` · `platform-nest` **video recording works end to end — the gap in the audio-only recorder is closed.** The recorder shipped audio-only that morning for one reason: `isAllowedAudio` accepted no `video/*` container, so a browser video take would have been refused *after* the whole upload was sent. Rather than widen a validator on a guess, that was left as a stated gap. **The guess is now a measured fact.** **VERIFIED against the running `gaiada-whisper-1`** (`fedirz/faster-whisper-server`, which carries `/usr/bin/ffmpeg`): it demuxes a video container and transcribes its audio stream. The probe used a CONTROL, which is what makes it evidence — an opus-only `.webm` and a vp8+opus `.webm` built by ffmpeg from the SAME 3s audio track, differing only by the presence of a video stream, both returned HTTP 200 with the **identical transcript**; an h264+aac `.mp4` also decoded. Re-run recipe is in the code comment (POST to `http://whisper:8000/v1/audio/transcriptions` from inside the compose network — whisper publishes no host port — and prefix `MSYS_NO_PATHCONV=1` on Git Bash). **Backend:** `isAllowedAudio` → `classifyMedia` returning `'audio'|'video'|null`, adding `video/webm|mp4|quicktime|x-matroska|ogg|3gpp` + `.mov/.mkv/.ogv/.3gp/.m4v`; the generic-content-type extension fallback is unchanged (a plausible mimetype OR a recognised extension, never a spoofed name alone). Ambiguous `.webm`/`.mp4`/`.ogg` under a generic type resolve to **video**, the harmless direction — guessing audio on a real video refuses a valid upload, guessing video only permits a larger one. New `MEETING_VIDEO_MAX_BYTES` (default 500MB) beside the 200MB audio cap. **The subtle part, and the one that got its own test:** @fastify/multipart can register only ONE `fileSize` for the whole app, so `main.ts` now registers `maxUploadBytes()` = MAX(audio, video) and the **real cap is enforced per-kind in the handler**. Without that handler check, raising the plugin limit for video would have silently opened the audio path to 500MB uploads — an audio file sitting *between* the two caps sails past busboy, and before this change that case could not arise. Tested with a positive control: 2048 bytes is refused as audio and accepted as video under a 1KB/4KB test config, so the refusal is provably the per-kind cap and not just "2KB is too big". **Frontend:** `useMediaRecorder({ video })` requests the camera (720p `ideal`, never `exact` — an `exact` constraint turns an older webcam into OverconstrainedError, i.e. "recording is broken"), picks a video container, and caps bitrate at ~800 kbps video + 32 kbps audio so a 60-minute meeting lands near 220MB instead of the browser's multi-Mbps default force-stopping a meeting mid-sentence. Live mirrored `<video>` preview while recording (muted — an unmuted self-preview is an instant feedback howl) with a Paused overlay; the take plays back in a `<video>`, unmirrored because that is the real footage. `RecordControls` gains an Audio / Audio+Video radiogroup, **keyed** so switching modes mounts a fresh recorder rather than carrying a finished audio take into a video session and uploading the wrong medium. `RecordingWorkbench` follows the row's own `kind`, so an audio recording never raises a camera prompt it does not need. Upload `accept` and all user-facing copy now say audio *or* video. **A test-harness trap was hit and is now documented in place:** `routedWhisperFetch` matches on `url.startsWith(config.whisper.url)`, and in the byte-cap suite that config value is `""` — so `startsWith("")` matched EVERY url including Cerbos's own fetch, and `authorize()` began returning spurious 403s (then the stub leaked into the next test). This is exactly the failure that file's own header warns about; the fix is that the cap suite stubs nothing, because it asserts a 202 and never needs whisper. Verification: `platform-nest` **2555 passed / 1 failed / 4 skipped (178 files)** — the 1 failure is `src/modules/reports/report-seal.db.test.ts`'s seal-hash recomputation, **pre-existing and reports-owned**, confirmed by running it in isolation and by this change touching nothing under `modules/reports`. `meetings.test.ts` **27/27** against live PG + Cerbos (6 new: video/webm transcribes and keeps `content_type: video/webm` on the stored file, generic-type `.mov` classifies as video, and the three cap cases). `platform-ui` **928/928 across 95 files** (25 recorder tests, 6 new for video: camera constraint requested, video container + bitrate ceilings applied, preview stream exposed only for video and cleared before tracks die, audio takes never request video, the larger cap is used, and unsupported/blocked messaging names the camera). `tsc` clean both sides, `next build` green, `lint:withtenants` + `lint:migration-rls` clean. **Still not DEV-VERIFIED, same specific gap as the audio recorder:** the browser half runs against a faked `MediaRecorder` under jsdom, so no real camera or encoder has driven it. What IS now real rather than assumed is the whisper side. |
| 2026-08-03 | `platform-ui` **In-ERP audio recorder with real transport controls (start · pause · resume · stop · play), `0.7.1` → `0.8.0` PROTOTYPED.** The ERP's "Record" buttons never recorded anything — they only REGISTERED a `meeting_recordings` row and waited for the desktop capture-helper to attach a file, so there was no capture to pause, stop or play back. New `useMediaRecorder.ts` (state machine + lifecycle) and `LiveRecorder.tsx` (transport + playback + upload), wired into **both** call paths: `RecordControls` (register-and-upload in one step — reaches `/meetings`, PRD Studio, the client detail page and the project workspace, all four via that one component) and `RecordingWorkbench` on `/meetings/[id]` (upload into the existing row, hidden once a transcript exists so re-recording cannot silently overwrite a transcribed meeting). The take goes down the SAME server-side path as an uploaded file (`POST /api/:t/meetings/recordings/:id/audio` → whisper → `transcribed`), so nothing new was added to the backend. **AUDIO ONLY, deliberately:** `isAllowedAudio` (`meetings.controller.ts:42`) accepts `audio/webm|mp4|ogg…` and **no `video/*` container**, so an in-browser video take would be refused *after* the whole upload; rather than widen a validation allowlist on a guess about what the whisper container accepts, video capture stays with the desktop helper. **Correctness the tests pin, not the click-through:** the elapsed clock accumulates completed segments so paused time never accrues (asserted across a 2s-record → 5s-pause → 1s-record walk); every `MediaStream` track is stopped on stop/reset/**unmount** (the mic-indicator-stays-on bug); the 200 MB cap (mirroring `MEETING_AUDIO_MAX_BYTES`) force-stops and **keeps** the audio already captured rather than discarding it; a recorder error likewise preserves the take; `pause()`/`resume()` are inert outside their matching states; every object URL minted is revoked (create/revoke counted, not assumed); and `MediaRecorder.pause` absence hides the Pause control instead of rendering a dead button. **A real bug was caught by these tests, not by inspection:** `fileName`'s extension derived from the container requested at `start()` while the Blob's type followed the recorder's *negotiated* `mimeType` — so a browser negotiating `audio/ogg` produced `meeting-recording.webm`, and since the backend accepts a generic content-type ONLY when the extension is a known audio one, a stale extension can turn a good recording into a 400. Both now derive from one source in `finalise()`. Also: the recorder degrades honestly rather than silently — `unsupported` (no `mediaDevices`/`MediaRecorder`/container) raises no permission prompt at all, and a blocked mic is distinguished from an absent one in the user-facing copy, both pointing at the still-present upload fallback. **Status is PROTOTYPED, not DEV-VERIFIED, and the gap is specific:** 19 new unit tests drive a faked `MediaRecorder` under jsdom (which implements neither `MediaRecorder` nor `navigator.mediaDevices` nor `URL.createObjectURL`), so the state machine and lifecycle are verified but **no real microphone, real encoder, or real browser has ever exercised this path** — and the upload→whisper→`transcribed` hop has not been re-driven live. `tsc` clean, `next build` green, suite **921/922**. **The 1 failure is pre-existing and NOT this change:** `src/styles/tokens.test.ts` "components never hardcode a colour literal" — it scans only `.css` files under `src/components` and this change adds none; proven by stashing the change and re-running on clean HEAD, where it fails identically. It belongs to the UI-polish token program. |
| 2026-07-31 | `reports` **TR-30 — documentation + seed + registry sweep, 0.1.0 IN PROGRESS → 0.3.0 PROTOTYPED.** P0–P2 substrate + fact fabric + check-ins complete; P3–P4 documents + exports + PDF endpoints built (sidecar DEV-VERIFIED); P5–P6 appraisal engine + MCP tools built (6 tools registered). Four controllers + 25 HTTP endpoints + 6 MCP tools live. **P1–P6 honest status: mostly PROTOTYPED with DEV-VERIFIED parts** (fact job 403+ tests, TR-35 report-rollups DEV-VERIFIED, sidecar 14 tests, MCP tools + appraisal engine tested). Known gaps: appraisal UI (TR-26), retroactive leave stale-history (TR-41), the live mint→sidecar→print-route PDF hop (TR-29), production deployment. **⚠ CORRECTED 2026-07-31 by the architect: this entry originally also listed "report viewer/charts" and "print route" as gaps — both were FALSE.** TR-16/TR-17 (chart kit, `ReportViewer`, `PeriodSelector`, all four grain routes, 862 UI tests green) and TR-20 (`app/print/reports/[jobToken]` + `print.css`, real PDFs inspected) had already landed and were verified on disk. The claims came from reading the blueprint's ticket list instead of the filesystem — **a registry that declares an existing surface unbuilt invites someone to rebuild it, which is worse than an omission.** Registration: `FRONTEND-BFF-CONTRACT.md` §15 added (documents/checkins/appraisals surface detail + known gaps), `MODULES.md` version bumped (detailed P0–P6 completion report), `CHANGELOG.md` entry recorded. Demo seed extended: `npm run seed:agency` now populates check-ins + work-facts for seeded tenants so report surfaces are reviewable. Full summary: design section 514–547 of `MODULES.md`, blueprint `tracker-reporting-foundation.md` §15 amendments. |
| 2026-07-31 | `search-marketing` **`0.3.0 → 0.4.0` IN PROGRESS. Bundled ⚡ gate PASSED (SM-54/56/59/61/25b all LANDED); echo-validation standing rule adopted + audited; a hardening wave opened and mostly closed; SM-23 docs/registration reconcile executed.** The bundled owed gate from 0.3.0 (tracker §6bc) passed SM-54 (scheduler), SM-56 (collect-scope double-charge, fixed by SM-63), SM-59 (`vendor_ref` reconciliation predicate) and SM-25b (GSC/GA4 reads, one residual → SM-64) — all four move to **LANDED**. SM-63 (collect-edge scope check, `ledgerRowScopeMatches`) LANDED. Architect rulings (§6bc) adopted **echo-validation** as a standing rule (any request-side constraint must be re-verified on the response before persistence; addendum §A14, now A1.7) and a **negative-control rule** for concurrency/serialization guard tests (a guard test is evidence only when shown red with the guard removed AND the removal is the *plausible* defect, not a syntactic deletion — sharpened twice this session after catching two more equivalent-mutant false passes). SM-65 (read-only audit) found 6 echo-validation gaps across the three vendor drivers and spawned SM-66…70: **SM-66/67/69 DEV-VERIFIED** (Ahrefs true-up header hardening, DataForSEO `task_get` identity refusal, DataForSEO backlinks target identity) — all gates owed. **SM-30** (manual apply/export twin — Ads-Editor CSV + `apply_manual` door, zero OAuth) and **SM-20** (search-terms callback + reader, migration `0062`, second callback secret, schema-level idempotency) are both DEV-VERIFIED, gates owed — both had shipped to disk with their §1 rows still reading `TODO`, now corrected. **SM-68/70** (DataForSEO billing-identity ruling — record every vendor-ack'd charge, refuse the *data* on a canonical keyword-echo mismatch, §6bi) reached DEV-VERIFIED with the full module tree green (894 passed / 4 skipped, zero reds, §6bj) — **and then an orchestrator `git checkout` destroyed the uncommitted `providers/dataforseo.ts`**, reverting SM-56/67/68/69/70's work in the one file it lived in. **RECOVERED same-session** (tracker §6bk): a rebuild against the surviving, untouched test files restored the implementation in full — `tsc` clean, `dataforseo.test.ts` 48/48, full tree **895/4 skipped, zero reds**, six mutation probes each `sha256sum`-verified byte-identical. SM-56 stays LANDED unaffected; SM-67/68/69/70 still owe their ⚡/QA gates, now against the recovered code, not against nothing. **SM-23 (this entry) also found:** SM-19's dual-mode apply-execution picker (`PaidActionGate.tsx`, `ApplyProposalTwins.tsx`, wired live into the Rankings and planner console pages) is real, committed, and covered by the `platform-ui 0.7.0` release's "729 tests green" figure recorded in the App release log above — but had **no §6 ticket narrative anywhere in the tracker** and its own row still read a bare `TODO`; corrected to `IN FLIGHT`, not promoted to `DEV-VERIFIED` (no ticket-scoped AC pass exists). `FRONTEND-BFF-CONTRACT.md`'s PENDING table had two stale rows claiming the Rankings and Ads-Studio (manual-mode) console UI was "unclaimed" — both corrected. `MODULES.md`'s search-marketing section had fallen one gate-cycle stale (still called SM-56/59 "gate owed" after they'd LANDED) and its migration list stopped at `0060`, missing the already-applied `0061`/`0062` — both corrected, version bumped `0.3.0 → 0.4.0`. **The at-ticket-creation-row standing rule (adopted §6au after SM-56/59 fell through a gate-bundling gap) was breached a second time** — SM-66/67/68/69 were created (§6be) with no §1 rows until §6bi noticed — recorded as SM-23's own regression case; the rule needs a mechanical check, not another reminder. **Still open:** SM-19's ticket-scoped verification, all the gates named above (now including SM-67/68/69/70 against the recovered driver), SM-25c/SM-26/SM-21/SM-22 (SEM apply/reports, still TODO), and real-vendor-account verification (OQ-2/9/10/11, unfunded). |
| 2026-07-30 | `search-marketing` **P1 fully LANDED (M2 reached) · P3's SM-18 LANDED · P5 hardening wave (SM-50…SM-61) opened and mostly closed · SM-23 doc-reconcile pulled forward.** ⚡ gates cleared: SM-08/SM-10/SM-13 (§6y — the oldest gate debt), SM-18 (cluster→plan generator + RSA/negative AI drafts + change-proposal CRUD, §6r+§6x.1), SM-25a-service/SM-58/SM-60 (§6ar), SM-51 (Google OAuth sandbox, §6ar), SM-14 remainder + its gate (§6af/§6ak). **The money-path P0 (SM-50, incurred-cost ledger rows) FAILED its first gate (§6ak), was fixed by SM-60, and PASSED (§6ar)** — migration `0053`. SM-52 (money-env-guard widened to all nine cap/price/ratio vars), SM-53 (typed dispatch refusals → honest HTTP, never 500) and SM-55 (SM-15's blocked n8n flows retired + deny-by-default regression test) also LANDED. SM-25a's HTTP surface (Google OAuth routes, `search-google-oauth.controller.ts`) is DEV-VERIFIED with its gate PASSED (§6as). **Correction applied by SM-23 (this entry) to two rows this seat itself wrote wrong:** SM-56 (collect-edge double-charge fix) and SM-59 (`vendor_ref` reconciliation predicate) are DEV-VERIFIED (§6an) but had **no gate section naming them** — §1's legend requires merged **and** gated for `LANDED`, so both are corrected to **IN FLIGHT** pending a bundled ⚡ gate (§6au) that also covers SM-54 (the platform-side pull scheduler, off by default — a money control) and the newly-ruled SM-61 (absent-cadence = on-demand, never weekly-default). **SM-23 also found:** twelve P5 tickets (SM-50…SM-61) existed only in narrative sections with no §1 ledger row at all — now added, and two standing rules adopted (a ticket gets its ledger row at creation; a gate section must name every ticket it covers). Added `SEARCH_SCHEDULER_ENABLED`/`SEARCH_SCHEDULER_INTERVAL_MS` to `platform-nest/.env.example` and `infra/compose/.env.example` (present in code/`config.ts` since SM-54 but missing from both example files) — documented as a money control (does this environment spend vendor money unattended), not a performance knob. `docs/FRONTEND-BFF-CONTRACT.md` §14 corrected: the engagement ledger read (SM-17, `GET engagements/:id/ledger`) is built and UI-wired (`CostLedgerPanel.tsx`) and was wrongly still listed as fully PENDING; only the tenant-scope MTD/threshold-event reads remain unbuilt. `docs/modules/MODULES.md`'s search-marketing "What exists (dev)" narrative was three landings stale (still described P0 as in-progress and SM-07/SM-11 as unbuilt) and has been rewritten against current code. **Still open:** the bundled ⚡ gate (SM-54/56/59/61), SM-17's own QA gate, SM-25b/25c (Google read paths, TODO), SM-19/20/21/22/30 (SEM apply/report loop, TODO), and real-vendor-account verification (OQ-2/9/10/11, unfunded). |
| 2026-07-30 | `reports` **TR-07 — nightly fact job + attribution engine (P1's correctness heart), `0.0.0` PLANNED → `0.1.0` IN PROGRESS.** `src/modules/reports/fact-job.ts` computes `report_work_facts` — the atomic `person × project × day` grain — plus `POST /api/:t/reports/facts/recompute {from,to}` (new Cerbos kind `report_admin`/`recompute`: platform-admin + group-executive + own-company admin; dept lead deliberately EXCLUDED per design §8). **Pure core, I/O at the edges** (house pattern): `computeFactRows()` is DB-free and clock-free, `gather*()`/`writeFactSlice()` hold every query; department resolution CALLS TR-04's `resolveDepartment` rather than re-deriving precedence ①–④, and the drift sweep CALLS TR-02's `logAssigneeDriftIfAny`. **Idempotent by construction:** each `(tenant, fact_date)` slice is a DELETE+INSERT in ONE transaction, and row ids are **deterministic uuid v5 over the table's own UNIQUE key** so two recomputes produce byte-identical rows — asserted on FULL row snapshots, with `computed_at`/`job_run_id` required to MOVE (proving the slice was genuinely rewritten, not silently skipped). §3.1's attribution table is pinned case-by-case (person-owner · unit-owner+responsible · unit-only · no-assignee) and a unit-assigned task never invents a person; Σperson ≤ Σunit = company holds with the unattributed bucket EXPLICIT; a 60-day backfill converges. Rulings honoured: `actor_user_id IS NULL` stays person-unattributed (TR-31's machine actors) but still lands on the unit axis; a SUSPENDED service edge still resolves a cross-company person's own unit and only withholds the provider stamp (TR-04 ruling); done-ness reads the consumer's `is_done`-FLAG-derived verbs; `pm_tasks.deleted_at` is filtered by the job (TR-01 backfilled soft-deleted tasks on purpose); `origin_site` passed explicitly. §5.3's leave-aware `auto_missed` check-ins ship with it (holiday/weekend/approved-leave/attendance produce nothing; a submitted or excused row is never overwritten; today is never marked missed). **Two substrate findings for TR-08:** `report_work_facts` has no `tasks_completed_with_due_date` counter, so metric #3's specified denominator (Σ completed-**with-due-date**) is not computable from the landed grain; and the shared `HttpErrorFilter` flattens every error body to `{error, field?}`, so §6.2's `422 {error:'range_too_large', maxDays:400}` ships as `{error:'range_too_large', field:'to'}`. 57 new tests (31 pure + 26 live-PG/Cerbos), `tsc` + `lint:withtenants` clean. |
| 2026-07-30 | `webdev` **WD-29 — pipeline state-transition idempotency (DEF-2 fix), DEV-VERIFIED live on a genuinely-racing driver.** `pipeline-delivery.json` is **byte-identical** (untouched, D-10 spirit); the whole fix is platform-side. New `src/core/pipeline-lock.ts`: a per-run xact advisory lock (`pg_advisory_xact_lock(0x50520001, hashtext(run_id))`) taken as the first statement inside `withTenants` by **every** run-state transition — `createStage`, `updateStage`, `openGate`, `decideGate`, `recordScopeSignoff`, `updateRun`, **plus the two client-side portal paths** (`portal.decideGate`, `portal.scopeSign`), which is where `prd_sign` and `customer_feedback` actually land in production; locking only the internal controller would have left the real-world race fully alive. **The lock alone is a no-op and that was proven, not assumed:** with the lock in place but the precondition re-check removed, the racing driver still produced **6 duplicate rows** — because each racer executes a decision computed from a snapshot read seconds earlier in n8n. The actual fix is lock + server-side re-evaluation of the workflow's own precondition (`existingStageForRepeatedCreate`): a `claude_design` create is admitted only if no design exists (initial `release_design`) or the CURRENT head design carries a decided `customer_feedback: changes_requested` (a genuine revision) — mirroring `Load + decide`'s own rule, so WD-05's bounded revise loop keeps working while raced twins resolve to the live head with `deduped:true` (same shape `createRun` already returns). Single-shot names (`prd_extract`/`report_extract`/`scope_extract`/`claude_code`/`staging`/`production`) dedupe on existence; `openGate` additionally suppresses a duplicate PENDING gate per `(run, stage, kind, actor_side)` — a duplicate pending twin would **stall a run forever**, since `gof()` resolves a beat to the LAST gate of its kind. `scope.signed` now emits on the TRANSITION to complete only (a re-filed signature was previously a row-level no-op that still re-announced the event, starting a delivery execution from nothing). Migration **`0052_pipeline_stage_idempotency.sql`**: partial `UNIQUE(run_id, track, name)` over the six single-shot names + a causal data repair. **The architect's stated repair rule ("keep-oldest, drop the rest") was wrong on all three counts and the live audit caught it before it destroyed data:** (1) the headline "4 groups / 6 excess rows" **over-counts** — run `019fb0a4` is WD-08 §1.6's *correct* rev-1/rev-2 revise pair (0 excess) and `019faebe` raced twice around one genuine revision (2, not 3), so true excess = **4**; (2) keep-oldest keeps the WRONG row — `Load + decide` always operates on `designs[designs.length-1]`, so the newest is the live lineage (run `019faec4`'s older twin held an orphaned *pending* `pm_review` while its newer row carried the whole decided chain incl. the client approval); (3) the rows aren't interchangeable (each `artifact_ref` differs — LLM output) and `pipeline_gates.stage_id` is a real FK, so a naive delete either fails or orphans human decisions. Repair instead pairs consecutive designs and treats them as raced unless a `changes_requested` was decided BETWEEN them; the excess row's gates are DETACHED + **soft**-deleted (never hard-deleted — two carried a `pm_review` a human really did approve). Live: 13→9 designs, 67→63 stages, 4 gates detached+soft-deleted with `decided_by`/`decided_at`/`decision` intact, dup groups 4→2 (both remaining are legitimate revise pairs); **idempotency proven by deleting the ledger row and re-running the real migration as `platform_owner`** — all counts unchanged. `npm run lint:migration-rls` green on `0052`, and the lint was shown to be load-bearing (removing the `set_config` wrapping makes it flag both the gate UPDATE and the stage DELETE). **Live racing verification against the running `:3004`:** 8 concurrent deciders parked behind a pre-taken lock → exactly 1 row, 7 `deduped`, one stage id; lock scope proven correct by holding run A's lock while run B transitioned in **48ms** (a per-tenant lock — the plausible wrong scope — would have serialized the entire pipeline, since every run shares the one agency tenant). **The genuine end-to-end race was reproduced, not merely hoped for:** firing the two platform triggers only serializes (the bridge delivers events one at a time — executions ran 171ms APART), so both workflow webhooks were POSTed concurrently instead, yielding **three overlapping `WS11 delivery track` executions (04:06:08.614/.660/09.259) that ALL returned `action:"released_design"`** — every one decided to create a design — and exactly **ONE** `claude_design` row plus exactly ONE pending `pm_review` resulted. New `pipeline-race.test.ts` (15 tests) is built on a deterministic race window (pre-take the lock, fire N, release) and carries a falsifiability anchor that reproduces the pre-fix duplicate at SQL level. Suites: `platform-nest` **1235/1238** (the 3 failures are the pre-existing `search-notifications.test.ts` `REDIS_URL not set` baseline, SEO-owned), WD-03 signature-lock + façade + WD-05 `updateRun` tests specifically re-verified green, `tsc` + `lint:withtenants` + `lint:migration-rls` clean. **Known limitation, stated plainly:** the schema-level backstop deliberately does NOT cover `claude_design`, because a legitimate revision and a raced duplicate are indistinguishable by the columns on the row (the discriminator is cross-table and causal) — covering it needs an additive revision-discriminator column, which is a write-contract change outside this ticket's approved DDL scope and is filed as a follow-up. |
| 2026-07-30 | `webdev` **WD-26 — digests + stale-nag + relink + n8n hygiene, DEV-VERIFIED live.** Two new n8n CRON flows modeled on `compliance-gate-nag.json` (read → `llm.summarize` → `notify`), the sole `work_activity`-reading digest source (explicitly NOT the legacy `activity.feed` hub tool, which reads the OLD flat `activities` table — LD-16's named trap). `wd-digests.json`: daily 17:00 (1-day window) + weekly Friday 17:00 (7-day window) per-person AND per-project activity digests, one `llm.summarize` call per grouped person/project (never per activity row — the shared/rate-limited Ollama Cloud key stays protected); the weekly branch also fires one `workActivity.relink` sweep. `wd-stale-nag.json`: daily, open `pm_tasks` with no linked activity in N=5 days → nag the assignee; ≥2N=10 days → ALSO notify the project owner (proven with real seeded tasks at 6 and 12 days stale — the 12-day task produced BOTH a `stale_task_nag` and a `stale_task_escalation` row, the 6-day task only the nag). New hub tools (`mcp-hub/src/work-activity-tools.ts`): `workActivity.feed`, `workActivity.staleTasks` (BE computes `daysStale` server-side off `COALESCE(last linked activity, task.created_at)` so N/2N bucketing needs no extra call), `workActivity.relink` (LD-16's deterministic relink sweep — re-runs the pure `deriveLinks` engine over zero-link rows, bounded batch, idempotent by construction). New scoped accounts `wf:wd-digests` (company_admin — needed for the relink tool's admin-only write tier) and `wf:wd-stale-nag` (manager), allowlisted to exactly their own tools (cross-checked: neither can see the other's). **A separate, narrower sweep rides the same ticket per the coordinator's live-data finding:** `POST /api/:t/meetings/recordings/relink-orphans` reconciles `meeting_recordings` rows orphaned by the (now-fixed) 5s ingest-proxy timeout (DEF-1) — matches `meeting_id` ↔ `pipeline_runs.source_meeting_id`; **3 real orphaned rows existed in the live DB and were fixed live** (scanned 13 → relinked 3 → re-run scanned 10/relinked 0, proving idempotency). WD-08-R1 (dispatcher 401 on bad secret) and R2 (dedupe echoes `runId`) were already fixed by another agent before this ticket started — verified still intact post-verification (not re-fixed, not clobbered), along with `pipeline-delivery.json`'s DEF-3 `Suspended (D14)?`/`approvals.request` nodes. **Live verification method:** n8n's CLI `execute` refuses schedule-triggered workflows outright in 2.30.4 ("Missing node to start execution") and the REST API requires an authenticated session, so both flows were fired via a temporary `executeWorkflowTrigger` node patched directly into the n8n Postgres store (never the committed file) routed at each branch in turn, using a one-off `docker run` sharing the real container's data volume + `--add-host=mcp-hub:host-gateway` (the compose `extra_hosts` trick standalone n8n needs); the temp node was stripped by re-importing the clean committed JSON before final reactivation — verified byte-identical after. **A real bug was found and fixed via this live testing, not by inspection:** the digest flow's `Is project?` IF-fan-out reconverges two branches into one downstream node without a Merge, so that node executes once PER BRANCH (separate "runs", not one batched call); `$('NodeName').first()` blindly grabs run-index 0 regardless of which branch's item is actually in flight, and crashed when the project branch's zero-item run happened to land at index 0. Fixed by switching the two affected back-references to `.item` (pairedItem-resolved), which is correct regardless of run ordering — confirmed by an end-to-end `status:"success"` execution producing a real `llm.summarize` call over 49 real live activity rows and a real `notifications` row. **Two rebuild surprises, not migration-related:** `platform-nest` and `mcp-hub` both run compiled `dist/` images in this stack (`build: ../../X` in the vps compose file, no source bind-mount) — the stale-tasks endpoint's live 500 and the hub's initial "unknown tool: workActivity.feed" were both stale-image artifacts, not code bugs; both rebuilt+recreated clean. Two SQL bugs caught only by the live Postgres (not the test suite, which happened to tolerate them): `$2 || ' days'`'s implicit-text-parameter ambiguity (fixed via `make_interval(days => $2::int)`) and a bare `l.target_id = t.id` comparing `text` against `uuid` (fixed via `t.id::text`) in the stale-tasks LATERAL join. No migration in this ticket (stale-tasks/relink are pure reads/writes over existing `work_activity`/`pm_tasks`/`pm_project_meta` tables). `platform-nest` full suite: 106 files/1223 tests, 3 pre-existing failures unrelated (`search-notifications.test.ts` `REDIS_URL not set`) + `tsc` clean; `mcp-hub` full suite 16 files/105 tests green + `tsc` clean except the pre-existing `module-tools.test.ts` `fetch.mock` typing issue. `docs/FRONTEND-BFF-CONTRACT.md` §11 extended with the new stale-tasks/relink rows. |
| 2026-07-30 | `webdev` **WD-28 — PM per-project short-codes (OQ-7 default), Phase-3's first landed ticket — DEV-VERIFIED.** `projects.short_code` (`UNIQUE(tenant_id, short_code) WHERE deleted_at IS NULL AND short_code IS NOT NULL`, derived on creation: first 3-4 uppercase alnum chars of the name, numeric-suffixed on collision) + `projects.task_seq` (atomic per-project counter) + `pm_tasks.seq` (`UNIQUE(tenant_id, project_id, seq) WHERE seq IS NOT NULL`); `CODE-SEQ` display form (e.g. `WEB-142`) computed server-side and returned on every `pm_tasks` read. **Atomicity:** single `UPDATE projects SET task_seq = task_seq + 1 WHERE id=$1 RETURNING task_seq` inside the same transaction as the task INSERT — the row lock serializes concurrent allocators; proven with 30 genuinely concurrent live HTTP POSTs against the running `:3004` container (`Promise.all`/backgrounded curl, not sequential) yielding seq `{1..30}` with zero duplicates. **Two migrations, not one — `0050` shipped a real defect, corrected by `0051` the same day:** `0050`'s backfill DO block ran as `platform_owner` (no `BYPASSRLS`, per the 2026-07-15 DB-topology role split) against `projects`/`pm_tasks`' FORCE ROW LEVEL SECURITY with no `app.current_tenant_ids` GUC set — RLS silently filtered every row to zero, so the backfill inserted nothing while the DDL half still committed and the ledger recorded "applied" with no error. Caught by this ticket's own live-DB verification (not by the test suite, which runs migrations as an unrestricted superuser and never exercises this path). `0051` reruns the identical backfill logic wrapped per-tenant (`set_config('app.current_tenant_ids', <company id>, true)` before each tenant's rows), verified idempotent by direct re-execution against `platform_owner` bypassing the ledger three times running (zero changes after the first). Cross-tenant isolation verified live: two different tenants derived the identical literal short_code text with zero collision. `tsc` + full `platform-nest` suite (106 files/1213 tests, 3 pre-existing failures unrelated — `search-notifications.test.ts` `REDIS_URL not set`, SEO/search-owned) and full `platform-ui` suite (67/67, `tsc` + `next build` clean) both green. |
| 2026-07-30 | `reports` + `report-renderer` **registered at `0.0.0` PLANNED — design only, no code.** New cross-cutting program: [`../blueprints/tracker-reporting-foundation.md`](../blueprints/tracker-reporting-foundation.md) — a multi-grain (person → project → department → company) reporting + appraisal layer over the **existing** PM tracker, at day/week/month periods, for management presentation and appraisal. **Deliberately not a new tracker:** the reuse audit found the substrate mostly already present — `work_activity`/`work_activity_links` (`0030`) is already the 4-grain evidence fabric, `metric_definitions`/`rollup_metrics` is already a governed metric registry with `ratio_of_sums`, `pm_progress_snapshots` (`0040`) already does nightly project-grain snapshots. **Three verified substrate blockers gate everything and are solved in P0:** (1) `pm_tasks.assignee` is a single unindexed JSONB blob with no multi-assignee — and a dept-assigned task has no person at all — so person-grain SQL is not trustworthy → relational `pm_task_assignees` with JSONB backfill + dual-write; (2) department resolution lives in the **frontend** (`platform-ui/src/lib/departments.ts`) off the org blob and is **not time-aware**, so a dept transfer would retroactively rewrite history → server-side resolution + as-of-date `org_unit_memberships`; (3) the estate has no chart lib, no XLSX and no PDF anywhere (only a hand-rolled SVG sparkline and a client-side CSV blob). Locked owner decisions: owner-takes-all attribution + listed contributors (company totals never double-count), **mandatory** per-person EOD check-ins (compliance measured against the HR working calendar so leave is not a false negative), manager-weighted blended appraisals with mandatory commentary + append-only acknowledgement, and server-side PDF now via a Playwright sidecar. Architecture invariants: one atomic `person × project × day` grain with additive rollups and numerator/denominator ratios; one typed `ReportDocument` feeding viewer + exporters + AI narrative + MCP tools; sealed period-close snapshots for management/appraisal vs live recompute for ops. Migrations `0050`–`0055` (**not 0048** — `0048`/`0049` were consumed by search/meeting work while the brief was being drafted; re-verify at TR-01). 30 `TR-*` tickets, P0=5 · P1=3 · P2=4 · P3=6 · P4=4 · P5=4 · P6=4, 12 QA-gated, 3 tagged Opus with in-doc justification. **Verdict recorded:** reporting NEEDS the never-built P1-05 pm→`work_activity` outbox consumer (TR-05), so person-grain completion history starts at TR-05 go-live and the first sealed month is the first appraisal-grade month. Five open questions await owner ratification (see design §13). |
| 2026-07-30 | `webdev` **WD-07 — WD-04's missing frontend + capture UX polish + docs truth (7 of 8 Phase-1 tickets landed).** Built the browser-upload half of WD-04's AC (backend was curl-only verified): `AudioUploadForm` on `/meetings/[id]` (poll-until-terminal via new `GET /api/meetings/:id/status`, mirrors `WhatsAppConnect.tsx`'s pattern) + a combined register-and-upload path in `RecordControls` for the no-existing-recording case; surfaces `transcribing` progress and a `failed`→retry affordance; DEMO_MODE equivalent (`demoUploadAudio`/`demoRetryAudio`, filename-triggered failure simulation) with 7 new unit tests. Verified client/project context end-to-end from the UI: `RecordControls` takes optional `clientId`/`projectId` (wired into the project workspace's new "Meetings" card and the client detail page); the dispatcher's client-context drop (WD-01 finding F-1) was already fixed by another agent — this ticket verified the chain, not re-fixed it. Added run-status chips on `/meetings` (linked pipeline run's own status) and a source-meeting deep link on PRD Studio. Reconciled `FRONTEND-BFF-CONTRACT.md` §8 — the meetings/pipeline/portal rows were still flagged "no UI consumer yet", which had been false since WD-02/WD-04 landed. Registered `webdev` `0.7.0 IN PROGRESS` in `MODULES.md` (was unregistered — the design doc's "register on approval" instruction had never been carried out). `tsc` + `next build` clean, 66 test files / 645 tests green. **Known defect surfaced, not fixed (queued WD-08):** the ingest proxy's `N8N_BRIDGE_TIMEOUT_MS` (5000ms default) is shorter than real dispatcher latency (15–23s), so ingest reports `dispatcher_unreachable` even though the run completes server-side — the UI already degrades honestly here (no false-success claim). |
| 2026-07-29 | `search-marketing` **P1 feature-complete — M2 reached PENDING GATES.** SM-08 (audit ingest, idempotency enforced by a `UNIQUE(tenant_id, property_id, kind, report_hash)` + `ON CONFLICT DO NOTHING`, not just in code), SM-10 (AI briefs/triage/report drafts, ≤1 gateway call per request with all network I/O outside any transaction), SM-12 (Site Audit + Keywords tabs now real surfaces; volume renders three distinct states so "switched off" is distinguishable from "no data"), SM-13 (9 event types → deep-linked notifications, dedupe + cross-tenant isolation tested) and SM-29 (editable scope grid) all AC-discharged. Verified: platform-nest **83 files / 821 tests**, platform-ui **577/577**, `tsc` + `lint:withtenants` + `next build` all clean. **Recurring bug class documented (tracker §4i): three silent frontend-first drift bugs in one day** — the console read fields the backend never sent (`limit` vs `maxKeywords`, a bare-vs-wrapped scope envelope, `tool_scope` missing from the LIST SELECT), each rendering a confident wrong answer while nothing threw; typecheck cannot catch it and demo fixtures hide it. Also fixed a real hydration divergence mis-reported as cosmetic (`toLocaleString` depends on runtime ICU data). ⚠️ **Five tickets sit AC-discharged but UNGATED** (SM-08/10/12/13/29) — the largest current risk in the module, given today's gates caught a money-path fail-open, two SSRF defects, a permanently-broken route and two fabricated doc citations. |
| 2026-07-29 | `search-marketing` **⚡ P1 gate CLEARED — SM-07 + SM-09 LANDED.** Final verified state: platform-nest **79 files / 785 tests**, `tsc` + `lint:withtenants` clean, `search-crawl-go` build/vet/test green. **The mandatory SSRF gate earned its name:** QA attacked the guard past its original 12 cases and two got through — (1) `isDeniedIP` missed the deprecated IPv4-**compatible** IPv6 form (`::7f00:1` = 127.0.0.1; `To4()` only unwraps the *mapped* `::ffff:` form, so every private/CGNAT branch skipped it and the classifier called it public — low/theoretical since modern kernels don't route it, but fixed regardless); (2) a **reachable** rate-limiter key skew — the allowlist stripped the FQDN trailing dot while `RoundTrip` only lowercased, so `site.example` and `site.example.` were one host to the allowlist but two budgets to the pacing layer, defeatable via same-host redirects. Both fixed, the second at its cause: one shared `normalizeHost()` now serves every host-keyed layer. **Cerbos decision: ACCEPT `update` for `/embed` + `/cluster`** — the architect overturned the concern with repo evidence (`resource_search_keyword.yaml` already grants `research`, a real-dollar paid pull, at the same baseline tier; design §07 types clustering as "AI draft | low"; embed/cluster never enter the SM-04 metered path). **SM-04 carry-overs applied:** 30s in-process TTL cache on `sumGlobalMonthToDate`, its read-only/aggregate-only invariant now **enforced by a SQL-shape test** rather than a comment, and `recordBlocked` guarded so a failing audit write can't mask `GlobalCeilingUnavailableError`. **Ticketed rather than silently accepted:** SM-32 (no cap on keyword-set size — one sequential gateway call per keyword inside a single held-open transaction) and a `parseKeywordImport` defect that corrupts commas inside quoted CSV fields. |
| 2026-07-28 | `search-marketing` **P1 begun: SM-09 + SM-07 AC discharged** (both awaiting their ⚡ gates). **SM-09** — keyword import (CSV/paste), `/embed` embeddings, deterministic dual-mode clustering, Hermes intent labels; no migration needed (0034 already had the columns); gateway is the asserted sole AI egress path; 1k-keyword determinism proven twice (pure-function scale test + full HTTP→DB integration), dual vector mode proven by an array-vs-pgvector-literal parity test since pgvector is absent. ⚠️ Flagged for architect: `/embed` and `/cluster` are gated under the existing Cerbos **`update`** action (no dedicated action exists), so keyword-edit rights also confer gateway-compute spend — may warrant new actions. **SM-07** — new standalone Go project `search-crawl-go/` + a `search-crawl` compose job. The egress guard enforces at `DialContext` and dials the **literal validated IP**, closing the resolve-then-connect race; redirect SSRF is covered by construction; rate limiting sits at `RoundTrip` so keep-alive can't dodge it; JSONL audit on every decision. 27 Go tests cover every required bypass class (DNS-to-private, redirect-to-private, IP-literal, IPv4-mapped IPv6, metadata IP, multi-A-record, DNS-failure-fails-closed); verified end-to-end in Docker incl. a real DNS rebind. SEONaut/open-seo-crawler/Unlighthouse runners **deliberately deferred** — one honest crawler proves the guard. **SM-31 (harness) RESOLVED:** per-file DB isolation replaced a shared destructively-reset database, so the full suite is trustworthy in one invocation for the first time — **78 files / 772 tests green, verified independently**, `tsc` + `lint:withtenants` clean. |
| 2026-07-28 | `search-marketing` **SM-11 console AC discharged — the SEO department now has a UI** (awaiting its own ⚡ gate). Pulled forward out of design order at the owner's call, since the department had no visible surface; legitimate because SM-11's only hard dep is SM-02. `platform-ui/src/lib/searchMarketing.ts` (typed BFF client — deliberately NOT `lib/search.ts`, which is unrelated global search) + the `seo` toolkit as the first **three**-craft-group console (Accounts / Optimize / Campaigns, D-10) + 12 routes. Engagements list + engagement detail render REAL landed data incl. the metered-tools table that explains why a paid pull was refused; the 10 capabilities whose backends are unbuilt render `BackendPending` naming their cost tier, missing endpoint and owning ticket rather than an empty table. `tsc` clean · UI suite **537/537** · `next build` green with all 12 routes. Two pre-existing toolkit tests that asserted SEO was unbuilt now assert the new spine (generic-fallback guard repointed at SMM). **Not done, deliberately:** the ticket's Connections additions — GSC/GA4/Ads need SM-25's OAuth work, which is externally gated. Contract documented in `FRONTEND-BFF-CONTRACT.md` §14. |
| 2026-07-28 | `search-marketing` **⚡ P0 gate CLEARED — SM-04 + SM-05 + SM-06 declared LANDED; M1 reached.** 126/126 across the six search suites on live PG + Cerbos (one file at a time, DB reset between files — see SM-31); `tsc` + `lint:withtenants` clean. **The gate found and fixed a fail-OPEN on the money path:** `dispatchProviderOp` degraded `globalMtd` to 0 when `sumGlobalMonthToDate()` threw, and a $0 month-to-date can never breach — so any error silently disabled the platform-wide ceiling, which on the default config (`globalMonthlyCapUsd` $150 always set, `tenantMonthlyCapUsd` null and skipped) is the ONLY platform-wide tier. Now fails closed via a new `GlobalCeilingUnavailableError` + a cost-0 `failed` audit row, pinned by a regression test. Architect decision: the `lint:withtenants` allowlist entry for `ledger.ts` `sumGlobalMonthToDate` is **RATIFIED** (aggregate-only/read-only; `SECURITY DEFINER` rejected because it would hide the cross-tenant read from the linter). **New ticket SM-31** (repo-wide, not search): the vitest harness destructively resets a test DB shared by all 74 suites, so multi-file runs fail nondeterministically — every failure is a schema-availability artifact, never a behavioural assertion; the full-repo `639/1` baseline is not reproducible until it lands. |
| 2026-07-27 | `search-marketing` **SM-03 declared** after verification (60/60 across the four search suites on live PG + Cerbos); status-doc drift reconciled (MODULES.md section said `0.0.0 PLANNED` while the registry said `0.1.0 IN PROGRESS`); execution tracker added (`blueprints/seo-sem-execution-tracker.md`). SM-04 confirmed half-built and now the critical path. |
| 2026-07-24 | **D1: WhatsApp + Agent runtime verified and documented** (`erp-whatsapp-and-agent-runtime-e2e.md`). wa-chat-bot 0.8.0 (session-lifecycle admin plane + writable group registry), platform-nest 0.6.0 (bot+agent proxies), platform-ui 0.6.0 (Connect-WhatsApp + Group Registry + agents-live surfaces), ai-agents 0.4.0 → PROTOTYPED (agent-runner service + goal/run store + queue), ai-gateway-go 0.11.0 (provider timeout + 429/RateLimitError breaker + error taxonomy), infra 0.5.0 (agent-runner + bot writable volumes + .env updates). Agent runtime DEV-VERIFIED end-to-end (pipeline+gateway+D13 forced_read_only persisted); bot session e2e (start→SCAN_QR_CODE→QR). UI-through path PROTOTYPED (not yet deployed — pending search-marketing build blocker). |
| 2026-07-23 | **Baseline versions assigned** to all modules for tracking-forward; this registry + changelog created. |
| 2026-07-23 | `creative` registered `PROTOTYPED` (Image Studio + `creative_assets` already in dev) with a v1.0 expansion design; new `render-gateway-go` added `PLANNED`. Foundation + design + PDF authored; 4 owner decisions locked; 27 tickets CR-00–CR-26. |
| 2026-07-23 | `social-media` added as `PLANNED` (foundation + v1.0 design; Postiz AGPL-contained; 3 decisions locked — scope, publisher, drop Chatwoot). |
| 2026-07-23 | `search-marketing` added as `PLANNED` (foundation + v1.1 design ratified; 4 owner decisions locked). |
| 2026-07-23 | `webdesk` added as `PLANNED` (blueprint approved). |
| 2026-07-15 | `observability` + `automation` reached DEV-VERIFIED (e2e on live Docker stack). |
| 2026-07-14 | `sync-engine-go` first prototyped; Node `ai-gateway` retired in favor of `ai-gateway-go`. |

> Older "Built/Complete" wording in `README.md` / `CLAUDE.md` predates this vocabulary — read it as
> `PROTOTYPED` / `DEV-VERIFIED` unless a production deploy is explicitly stated.

---

## platform-nest
### [0.33.0] - 2026-08-21 - IN PROGRESS (the principal discriminator, and the root boundary's fallout)
- **PK-01 — `users.kind` (`employee|client|automation|bot`).** Authorization here is defined over
  PRINCIPALS, so an n8n workflow has to be a `users` row to be authorized at all — which left
  "principal" and "person" as different sets with nothing in the schema telling them apart. On
  2026-08-03 HR reported 36 people when 19 were people and 17 were n8n service accounts. Backfilled
  from evidence already in the DB, never from a guess.
- 🔴 **Its own negative control found a defect in it.** The backfill was four sequential
  `UPDATE ... WHERE kind <> ...` statements, each of which could only assign TOWARD a non-employee
  kind — nothing could say "and otherwise you are an employee". After a deliberately GUC-blinded run
  classified a staff member as `bot`, re-running the real block left them a `bot` **permanently**.
  Rewritten as a single CASE: a total function of the evidence, so a wrong value self-heals, and
  precedence is explicit rather than emergent from statement order.
- **The design doc it implements was already stale.** It keys `client` on `clients.portal_user_id`,
  which migration 0072 replaced and records as "written ONLY in testing/fixtures.ts and NULL for every
  real client". Keying on the retired column alone would have classified ZERO real rows while looking
  like it worked. `client_contacts` is the real source; both are read so fixture DBs classify as
  production does.
- **PK-02 — the people surfaces ask `users.kind`, not `company_memberships.kind`,** and that was
  wrong in BOTH directions. TOO STRONG: the shared-service reconciler materializes a `kind='service'`
  membership in the SERVED company for real placed STAFF, so filtering on the membership **erased
  every shared-service human from the directory of the company they serve** — a colleague you cannot
  find or assign work to, purely for having been lent out. TOO WEAK: `GET /:t/members` filtered
  nothing at all unless `SERVICE_ASSIGNMENTS_ENABLED` was on (it is off by default), so the 17 n8n
  accounts were listed as members. The two dimensions are now separated: `u.kind` = is this a person
  (always); `m.kind` = is this placement ordinary (unchanged, still flag-gated). `isService` derives
  from `users.kind`, so a shared-service HR manager stops being badged as a robot.
- **`GET /api/rollups` authorizes against the caller's own ROOT company.** MON-00c gated the exec's
  rollup rule on `variables.inRoot`, which reads `resource.attr.tenantId`; this endpoint passed no
  tenantId at all, so the condition could not evaluate and a `group_executive` was denied outright on
  the one endpoint that exists to serve them — returning an error object where callers expected an
  array. Owner's ruling ("should be tenant id as we are using this for many company") implemented as
  the caller's root, which `rootCompanies` always contains. **Rejected** the alternative of allowing
  when tenantId is absent: that makes "omit the attribute" a way to skip a boundary check.
- **A pool `error` listener (`attachPoolErrorHandler`).** `pg` emits `error` on the POOL when a backend
  dies while its client is idle; with no listener that is an **uncaught exception**, so a Postgres blip
  restarts the ERP. Found via a CI failure that read `Test Files 356 passed` / `Tests 5275 passed` /
  `Errors 2` — every test green, exit 1.
- Gates: `users-kind-discriminator.db.test.ts` 5/5 (re-executes the migration's own DO block read from
  disk, so it cannot drift into testing a copy; runs as the app role because bypassing RLS would make
  the zero-row trap invisible); `users-kind-readers.db.test.ts` 4/4 (asserts BOTH directions, each the
  other's control); `cross-root-boundary.db.test.ts` 6/6 unchanged — the exec regains its own root and
  nothing else. Live-probed against production Cerbos: own-root ALLOW, foreign-root DENY.
### [0.32.0] - 2026-08-20 - IN PROGRESS ([agent-attribution-gate] interim: writes name the agent, not only the human)
- **`Principal.via = {provider, externalId, agent?}`.** Until now `Principal` carried
  userId · assurance · companies · roles · sessionVersion and NOTHING about the channel, so every
  `activities` row recorded "Alice did X" when the truth was "Alice's agent did X". That was not a
  dropped log line — it was information with nowhere to live.
- **The owner's `Co-Authored-By` framing, implemented literally.** AUTHOR = the human (`actor_id`
  unchanged; Cerbos still decides on them; an agent can never do what its principal could not).
  CO-AUTHOR = the agent, in `metadata.via`, recorded ALONGSIDE and never INSTEAD. Additive and
  authorization-neutral: nothing in `can()`/Cerbos reads it, so no policy needed re-reasoning.
- 🔴 **AMBIENT, NOT A SEVENTH PARAMETER — and that is the whole design decision.** `writeActivity` has
  **263 call sites**, 229 of which pass `req.principal.userId` and nothing else. Threading `via` would
  have been ~229 mechanical edits AND would have made attribution OPT-IN, whose failure mode is that the
  one site somebody forgets is the site that mattered, with nothing failing when they forget. Ambient
  context inverts that: a write is attributed unless something actively strips it. `AsyncLocalStorage`
  is an established idiom here, not a new one — `search/providers/types.ts`'s `withActualCostCapture`
  uses it for the same reason (parallel in-flight work would clobber a shared field).
- **Fail-silent by construction:** outside a request scope (a sweep, a consumer, the D14 executor)
  `currentVia()` is undefined and the row is written exactly as it always was. An attribution mechanism
  must never be able to break a write; the most it may do is add nothing. A caller's OWN `metadata.via`
  wins, because the executor re-driving an approved write knows the ORIGINAL filing channel — better
  provenance than the channel of the retry.
- **`x-obo-agent` is trusted, and only here:** the OBO block already requires the service token, so the
  caller is the hub or another first-party service. The value is authorization-neutral, so a client that
  lies gains nothing and incriminates an agent that did not act.
- Gates: `request-context.test.ts` 10/10 (new) — including concurrent scopes not leaking, the
  actor-still-the-human assertion, and the no-scope no-`via` case; `src/core` + `src/admin` + `src/auth` +
  `src/rbac` regression **1972/1972 across 120 files**; all five lints and `tsc` clean.
### [0.31.0] - 2026-08-20 - IN PROGRESS (owner decision: the four direct IAM writes go agent-reachable)
- **`iam.grantRole` / `iam.revokeRoleGrant` / `iam.assignPosition` / `iam.unassignPosition`** are
  declared, each with a D14 entry (`registerIamExecutableApprovals`) and each named in
  `resource_mcp_tool.yaml`'s executable allow-list. Full contract: PERMISSION-CONTRACT §14.
- 🔴 **THE OBJECTION WAS NOT ANSWERED, IT WAS OUTRANKED — and both code sites say so.** These were
  withheld because a role-granting tool is a privilege-escalation surface while audit attribution still
  records "Alice" rather than "Alice's agent". The owner ruled to proceed on the basis that every employee
  on the estate is mock data except their own account. **That was verified against the live database
  before shipping:** 23 `kind='employee'` memberships, all `.test` addresses bar `hansel@gaiada.com` (the
  only verified login) and one login-less `@gaiada.com`; 17 bots, all correctly `kind='service'`.
  **The basis expires when the data does** — closing [agent-attribution-gate] is now a hard pre-staging
  requirement, and the comments in `core-tools.ts` and `approval-executables.ts` exist to make that
  unmissable.
- **What did NOT change:** the executor still re-drives as the ORIGINAL FILING PRINCIPAL (an agent cannot
  exceed the human behind it), `GrantWriteService` is still the only writer of `user_roles`, the ceiling
  and sensitive gate and self-target DENY all still apply, and all four suspend for a human decision
  because medium/high writes do. These entries only make the approval COMPLETE instead of landing
  `not_applicable`.
- **Impact tiers with a structural argument, not a vibe:** `grantRole` is HIGH — the only one that widens
  authority. `assignPosition` is MEDIUM because a placement can confer only what the seat's role-set
  already carries, and that role-set was authored by a human through a surface with its own allow-list;
  the escalation ceiling is the position registry.
- 🔴 **Two preconditions are security properties rather than housekeeping.**
  `managed_by_position_not_revocable`: the reconciler would restore a position-managed grant on its next
  pass, so an approval that "succeeded" would leave the access standing while a human believed it was
  gone. And `position_not_active` deliberately covers **orphaned** seats — their unit is gone from the org
  chart and grants there are FROZEN, so a placement would appear to work and confer nothing.
- **No `preconditionModules`**, unlike the JML entries: every table these read is core (`user_roles` is
  global outright). Cargo-culting `["hr"]` would be harmless and would tell a reader something false.
- **Two pins I wrote earlier went RED, which is what they were for.** `core-tools.test.ts`'s exact
  tool-name list, and its test asserting these four were ABSENT. The second was inverted rather than
  deleted, keeping the history in the comment — a test guarded the absence precisely because it was a
  stated decision rather than a gap.
- **`McpToolDef.method` gained `DELETE`** (`iam.revokeRoleGrant`'s endpoint is one). The transport always
  supported it — `callPlatform` passes `def.method` straight to `fetch` — so only the type was narrower
  than reality, and since defs arrive as parsed JSON it never rejected anything at runtime; it just
  described it wrongly.
- Gates: `d14-iam-direct-registry.test.ts` 26/26 (new); affected pins 18/18; `src/core` + `src/admin` +
  `src/rbac` regression green; all four lints and `tsc --noEmit` clean; Cerbos restarted and the widened
  policy compiled before the run.
### [0.30.0] - 2026-08-19 - IN PROGRESS (P2-16 the three-mode battery; P2-17 contract sync)
- **P2-16 — the mover criterion proven in ALL THREE operating modes** (`iam-phase2-three-mode-battery.test.ts`,
  8 cases). Design §5.2's four-part criterion — (a) zero grants tagged to the closed assignment, (b) the
  OLD department probe 403, (c) the NEW department probe 200, (d) `session_version` moved — asserted
  identically under a UI persona (`x-user-id`), an agent OBO envelope, and an n8n OBO envelope.
- **(b) and (c) are probed against RUNNING Cerbos, never derived from a bundle.** `org_unit_lead`'s whole
  meaning is its condition, so a bundle check would report the same reach before and after a transfer and
  pass while the estate was broken — the [role-bundles-overstate-reach] lesson, applied.
- **What "three modes" is at this boundary:** three HEADER SHAPES and nothing else. Modes 2 and 3
  deliberately do not route through the hub — the hub's own contribution is covered by
  `d14-jml-registry.test.ts`, and routing through it would test the hub twice and the platform once.
- **The LEAVER assertion is stronger than a 403 and says so:** after terminate the probe returns 401,
  because `assemblePrincipal` yields null for a disabled user. There is no principal left to deny. A 403
  would mean "still a principal, currently unauthorized", which is a state a leaver must not be in.
- **Adversarial, per mode:** a plain member is refused in all three (and the victim's reach is asserted
  unchanged after three failed attempts); an UNVERIFIED OBO link gets an anonymous principal and is
  refused; a transfer to a retired position is a 400 that changes nothing; a cross-company transfer is
  refused. Two fixture defects were found and fixed while writing it: `hr_people_ops` is a DERIVED role
  (== `hr_manager`), so granting a role by that name satisfies nothing, and the hire endpoint returns the
  shaped employee at the TOP level rather than in an `{employee}` envelope.
- **P2-17** — PERMISSION-CONTRACT §13 (the backfill's sources, its two REVIEW categories, the
  report-only position import, and the count-assertion abort) and a FRONTEND-BFF-CONTRACT section for
  P2-13's five endpoints, including the five `state` values, why `actionable` is computed server-side, and
  why the 503 must never be rendered like an empty list. P2-15 adds no endpoint by design — applying it
  is a reviewed one-time operation, and an endpoint would invite a button.
- Gates: battery 8/8; admin + hr regression 457/457 across 36 files; `tsc --noEmit` and all four lints
  clean. Also verified on the LIVE box: `/api/:t/it/accounts` is routed (401, not 404),
  `dist/seed/iam-phase2-backfill.js` ships in the image, and the backfill's READ-ONLY dry run was driven
  against the real estate — 23 employees to create across two companies, 19 assignments correctly
  reported as not-derivable (no positions exist there yet), nothing to adopt, and NO automation
  exclusions, which is the evidence that every service account on the box is correctly `kind='service'`
  and the second wall never had to fire.
### [0.29.0] - 2026-08-19 - IN PROGRESS (P2-15 backfill + adoption; P2-13 the IT accounts backend)
**P2-15 — `src/admin/iam-phase2-backfill.ts` + `npm run iam:backfill`.** Four opt-in pieces; dry run is
the default and there is no flag that applies everything.
- **Adoption re-labels and NEVER widens, enforced as an ABORT.** `user_roles`' row count is read before
  and after INSIDE the writing transaction; a difference raises `AdoptionWidenedAccessError` and rolls
  the run back. The count is GLOBAL, not tenant-scoped — `user_roles` has no tenant column, and a
  tenant-filtered count would miss a row written with the WRONG scope, which is exactly the mistake that
  matters. Proven by a test that plants a row inside the apply transaction via a trigger and asserts
  both the throw and the rollback.
- **No second matcher.** "A grant that exactly matches what this seat confers" already exists once, in
  `position-reconciler.ts`; its `skip_manual` verdict IS the candidate list. A second matcher here could
  adopt a row the reconciler would never manage.
- 🔴 **The hazard a one-line INSERT…SELECT would have shipped:** automation accounts hold real
  `company_memberships` rows on purpose, so a membership-driven backfill mints a person-shaped HR record
  for every bot. The primary filter is `kind='employee'` (design §9's stated source — migration 0026's
  column, which I initially and wrongly recorded as non-existent). A SECOND wall excludes anything
  carrying an `n8n` identity link, because nothing ENFORCES the kind, and every exclusion is NAMED in the
  report so a reviewer can confirm the wall never fired on a human.
- **Two categories are REVIEWED rather than decided:** a `@gaiada.system` address with no automation link
  (including it puts a bot in HR; excluding it hides a person), and a staff membership for a client
  principal — impossible per 0072, so a non-empty list is a pre-existing data defect and gets a human,
  never an HR record.
- **Position import is REPORT-ONLY, permanently.** A blob `role` node carries no role-set, so an imported
  seat would confer nothing and then read, forever after, as a seat someone deliberately left empty.
  Pinned by a test that runs apply with every flag and asserts the `positions` count is unchanged while
  the candidate list is non-empty.
- **Assignments only where UNAMBIGUOUS** (exactly one active position in the unit); zero and many are
  both reported. `valid_from` is TODAY, never back-dated — back-dating asserts someone held a seat, and
  its roles, during a period nobody verified. `hire_date` is left NULL for the same reason.
- Operator guardrails: `--all-tenants` is dry-run only and refuses to combine with an apply flag; an
  unknown flag is a hard error (a typo'd `--adoptions` that silently dry-ran would read as "adoption did
  nothing"); every apply prints the before/after count so the claim is visible rather than trusted.

**P2-13 — `src/admin/it-accounts.controller.ts`** (design §5.4), over the existing
`core/keycloak-admin.ts`. Worklist + provision/disable/enable/reset-password, all idempotent, all audited.
- 🔴 **Degradation is a typed 503, never an empty list.** An empty worklist means "everyone has a login",
  which is the most dangerous sentence this surface can produce while blind.
- **Idempotence converges.** `provision` looks the address up first, and Keycloak's own 409 is treated as
  "adopt it" — including the race between lookup and create. Two logins for one address would be an
  authentication ambiguity, not untidiness. A double-provision returns `adopted:true` and NO password:
  an existing account's credential is not ours to rotate silently.
- **The initial password is returned once and never audited** (a credential in an activity row is a
  credential in every export of it). `reset-password` records the REASON instead.
- **The identity link is created UNVERIFIED**: an admin creating an account is not the person proving
  control of it.
- **NOT HR-module-gated** — IT provisioning is not an HR capability, and gating it would make login
  management vanish for a company with HR switched off while its people still need logins. Only the
  employment-status read is module-scoped, so its absence degrades the ROW; `leaver_still_enabled` can
  therefore only ever be claimed from real data.
- `deriveRow` is pure and exported, and `leaver_still_enabled` deliberately OUTRANKS `unverified_link`:
  a leaver who can still log in is a security finding, an unverified link is paperwork.
- ⚠ **I hit the trap `http-error.filter.ts`'s own header documents** — threw `{error: token}` where the
  filter renames `message` to `error` and reads nothing called `error`. Every typed refusal was arriving
  as prose with the meaning stripped; the status codes and shape were right, which is what makes it easy
  to miss. Tokens now lead the `message` string.
- Gates: P2-15 19/19 (incl. the abort-and-rollback proof), P2-13 25/25, admin regression 349/349,
  `tsc --noEmit` + all four lints clean. The P2-15 CLI was also driven end-to-end against a freshly
  migrated scratch database — dry run, both guardrails refusing, and an apply that wrote exactly one row.
### [0.28.0] - 2026-08-19 - IN PROGRESS (core gets a tool surface; IAM Phase 2 becomes agent-reachable)
- **`src/core/core-tools.ts`** — a registry for tools owned by CORE controllers, unioned into
  `GET /mcp/tool-defs` ahead of the module tools. Closes the structural gap 0.26.0 recorded: the
  endpoint returned `allModules().flatMap(m => m.mcpTools)`, so every tool needed a MODULE owner, and
  `positions`/`role-grants` have none — they are core controllers over core tables. The whole IAM
  Phase 2 surface was unreachable to an agent while `hr.*` was reachable.
- **Why not the other two options.** Folding them into `hr` is semantically wrong (granting a role is
  not HR, and `hr`'s tools are precisely the ones behind the HR module's RLS wall, which these are
  not). An `iam` ModuleContract would be a module whose tables are core and which no tenant can
  meaningfully disable — and `enabled_modules` would then imply IAM is switchable off.
- **A core tool has NO per-tenant enablement gate**, because core has no flag to consult. Stated in
  the file, because "advertised to every tenant" is a stronger default than a module tool's and anyone
  adding an entry is choosing it. Authorization is Cerbos + the controller's own guards — the same
  posture the human UI already has against these endpoints. No Cerbos change was needed:
  `resource_mcp_tool.yaml` is name-agnostic apart from automationScope and the D14-13 executable list.
- **Declared: three reads and two PROPOSALS.** `iam.listPositions`, `iam.listAttachableRoles`,
  `iam.listRoleGrants`, plus `iam.requestAssignment` and `iam.requestOverride` at impact **`low`** —
  load-bearing, not a shrug. Their entire effect is a PENDING approval row a human then decides;
  marking them medium would require an approval in order to ask for an approval, and (since a
  medium write needs a D14 executor to complete at all) would dead-end the natural agent path
  silently. Filing a request is the low-impact action.
- 🔴 **NOT declared, and this one is an owner decision rather than missing work:** `iam.grantRole`,
  `iam.revokeRoleGrant`, `iam.assignPosition`, `iam.unassignPosition`. The D14-executor objection that
  held the JML writes back is solved and the pattern is worked — this is a different and bigger
  objection. A tool that grants a role is a privilege-escalation surface, and the estate's audit
  attribution still says "Alice" rather than "Alice's agent". Granting rights through a surface whose
  attribution is known to be wrong is the combination worth refusing on purpose. Pinned by a test, so
  the absence is a position rather than a hole someone fills by accident. If the owner wants them, the
  work is three D14 entries plus allow-list names — small, and blocked on the decision, not the code.
- **The aggregator now THROWS on a duplicate tool name** across the two registries. It is the only
  place that can see both, and de-duplicating would make the advertised surface depend on registration
  order with the loser silently unreachable — a failure that presents as "the tool exists but does the
  wrong thing".
- `mcp-tools.controller.test.ts`'s "is empty when no modules are registered" case became "with no
  modules the aggregate is exactly the core set" — the fact it asserted changed, and the new fact is
  the point: core tools do not depend on modules.
- Gates: `core-tools.test.ts` 8/8 (new), aggregator 4/4, search module 26/26, `tsc --noEmit` clean.
### [0.27.0] - 2026-08-19 - IN PROGRESS (P2-07's write half: the JML loop closes, and an RLS trap inside it)
- **`hr.hireEmployee` / `hr.transferEmployee` / `hr.terminateEmployee` are declared**, and 0.26.0's
  refusal to declare them is now satisfied rather than waived: each has a `registerExecutableApproval`
  entry (`registerJmlExecutableApprovals`), and all three names are in `resource_mcp_tool.yaml`'s
  executable allow-list. All THREE parts are load-bearing — an entry without the allow-list passes its
  precondition and is then denied at the hub door, and a tool without an entry suspends and then does
  nothing on approval. `hr-employee-tools.test.ts`'s invariant now reads "declared WITH an executor".
- **`lockKey` is the PERSON**: `employeeId`, else the case-folded `workEmail` (the joiner has no employee
  row yet). Not the tenant (nearly one tenant here), not the approval id (the claim already serializes a
  row against itself). Namespaced per tool, and a malformed payload does not collapse onto one shared key.
- **Preconditions detect a first attempt that already landed** — `employee_already_exists`,
  `already_in_target_position`, `already_terminated` — and refuse a request the world moved out from
  under (`position_not_active`). That observability is why none of the three sets `neverAutoRetry`: this
  is `deploy.*`'s property, not `social.publishPost`'s.
- 🔴 **A DEFECT FOUND WHILE WIRING IT, in the executor and not in the new code.** `employees` sits behind
  the HR module's third RLS wall, and `core/approval-execute.ts` opens its claim transaction with NO
  module scope — correct for every entry that shipped before, because theirs are core tables. With
  `app.scopes` unset, `app_module_allowed('hr')` is false, so these preconditions would read ZERO ROWS
  **and no error**. For the hire that is silent in the PERMISSIVE direction: the one guard standing
  between a retried approval and a person created twice would have passed every single time.
  Fixed by declaring it: new `ExecutableApprovalEntry.preconditionModules`, applied by the executor as
  transaction-local `app.scopes` immediately before BOTH precondition call sites (claim + retry).
  Declared on the entry rather than set from inside a precondition on purpose — the executor owns the
  transaction, and a precondition that widened its own visibility would hide an RLS decision in the
  least visible place available.
- **`d14-jml-registry.test.ts` (37 cases)** carries a NEGATIVE CONTROL that asserts the broken behaviour
  on purpose: run unscoped, the hire guard passes on a person who already exists and terminate claims
  not-found; run scoped, both answer correctly. So `preconditionModules` cannot be deleted as cosmetic,
  and the fix is a claim with evidence rather than a comment. Plus the PRV-03 shape: stale requests land
  `failed` with `precondition_failed:*` and the hub is asserted — not inferred — to be called zero times,
  against a positive control that calls it exactly once.
- Impact: `high` for terminate (it revokes grants, closes seats, can disable a login, and is the one
  whose blast radius does not shrink on a repeat), `medium` for hire and transfer. All three suspend
  either way; impact drives urgency and notification tier, not whether a human is asked.
- ⚠ **Still open from 0.26.0:** `positions` and `role-grants` are CORE controllers with nowhere to
  declare tools, so they remain agent-unreachable pending a platform core-tools surface.
- Gates: `src/core/d14-jml-registry.test.ts` 37/37 (new); approvals + hr regression 311/311 across 18
  files; `tsc --noEmit` clean; `cerbos compile` clean and the test Cerbos restarted before the run.
### [0.26.0] - 2026-08-19 - IN PROGRESS (P2-07 partial: the employee READ surface goes agent-reachable)
- **`hr.listEmployees` + `hr.getEmployee`** declared on the `hr` module, so they reach the hub through
  `GET /mcp/tool-defs` with nothing hardcoded hub-side. `hr` owns them because `employees` sits behind
  the HR module's own RLS wall (`app_module_allowed('hr')`, 0109) — the module that gates the table owns
  its tools. Both require a verified caller; neither is a write.
- 🔴 **The JML WRITE tools are deliberately NOT declared, and that is the honest state.** Design §9 wants
  medium/high writes registered so an agent-origin approval EXECUTES. Declaring `hr.hireEmployee` before
  its `registerExecutableApproval` entry exists would give an agent a path that SUSPENDS and then, on a
  human's approval, does nothing — `getExecutable()` returns undefined, `execution_status` lands
  `not_applicable`, and the hire silently never happens. For a hire that is a person approved and never
  onboarded. `hr-employee-tools.test.ts` goes RED the moment one is declared without an executor.
- **Corrected my own first reading:** suspend-without-auto-execute is the estate's NORM for most tools
  and deliberate for the barred money-spending ones. It is wrong specifically for JML because §9 asks
  otherwise — not wrong in general.
- ⚠ **A structural gap P2-07 surfaced:** `positions` and `role-grants` are CORE controllers, and
  `/mcp/tool-defs` unions registered MODULES' tools. There is nowhere for them to be declared. Folding
  them into `hr` is semantically wrong (role granting is not HR); the alternatives are an `iam` module
  contract or a platform core-tools surface. Until that is chosen they cannot be agent-reachable at all.
- `hr.test.ts`'s exact tool-name list moved deliberately — it is the one place a tool silently appearing
  or vanishing from the agent surface shows up, so it moves in the same change, never loosened.
- Gates: employee tool surface 5/5, hr module suites 75/75.
### [0.25.2] - 2026-08-19 - IN PROGRESS (the IAM decision right splits in two)
- **`core.position.decide_assignment`** is split out of `core.role_grant.decide_override` at the owner's
  instruction (migration `0118`). A routed ROLE override and a dept head's PLACEMENT request now
  authorize against different Cerbos actions.
- **No behaviour changed on the day of the split**, and the migration says so in its own header: both
  actions are granted to the identical four tiers, so nobody gained or lost the ability to decide
  anything. What it buys: a description that matches what the permission does (the override key claimed
  to cover "granting authority beyond a position" while it was deciding placements too — unauditable),
  the ability to diverge later without a schema change, and an audit row that records WHICH kind of
  exception was approved. `0118` also corrects the override key's description in the DB.
- **The requester ≠ decider DENY is restated PER ACTION**, not shared: a DENY silently covering two
  actions is one edit away from covering neither. Both also fail CLOSED on an unresolvable requester.
  All four combinations pinned by live-engine probes.
- Tallies moved again (283 -> 284 pairs, 268 -> 269 grantable) — the third time in two days, and the
  maintenance tax this program already documented for hardcoded counts.
- Gates: live-probe + override/assignment batteries 38/38, full sweep 1289/1289 across 81 files.
### [0.25.1] - 2026-08-19 - IN PROGRESS (a dept head proposes; HR and admins place)
- **§11.2's owner end-state is done.** A dept head's `POST /positions/:id/assign` returns
  `assignment_request_required` naming `POST /positions/:id/assignment-requests`; that files an
  `automation_approvals` row (`origin='iam'`, `workflow_id='iam:position_assign'`) decided by the SAME
  `decide_override` action, in the SAME inbox, executed by the SAME seam. HR (`hr_people_ops`) and
  `company_admin` still place people directly — that is what the 2026-08-18 widening was for.
- **"Is this a dept head?" is answered by Cerbos, not by a role list.** The same authorization question
  is asked with EMPTY ancestry: only the tenant-wide tiers can pass it, because `org_unit_lead` matches
  on subtree containment. Nothing to maintain, nothing that can drift from the policy.
- **One execution seam** (`admin/iam-approval-execute.ts`) now owns both IAM request kinds, so the
  shared decide route gained one import instead of a second IAM-specific branch. The decide response's
  `override` key became `iam`, with `iam.kind` distinguishing them; non-IAM approvals still return
  `{ id, status }` with no `iam` key, pinned byte-for-byte.
- **What the flip did NOT relax**, each pinned: a lead still cannot reach outside their subtree —
  asserted on the REQUEST endpoint too, because a request path that accepted what the write path
  refuses would be the hole; nobody approves their own request; and a decision against a position
  RETIRED in the meantime is refused at execution rather than filling a dead seat.
- Gates: override + assignment battery 19/19, positions 27/27, full sweep 1279/1279 across 81 files.
### [0.25.0] - 2026-08-19 - IN PROGRESS (P2-08 part B: the routed override)
- **The refusal became a route.** A dept head who cannot grant a sensitive role directly now files
  `POST /api/:t/role-grants/overrides` with a justification; it routes by domain; the routed approver
  decides it through the EXISTING inbox; and an approving decision executes the grant IN-BAND with
  `expires_at` + `origin_approval_id`, bumping the target's session. Migration `0115`.
- **One route, no fork.** `automation-approvals.controller.ts` already picked its Cerbos action from
  `origin` + `workflow_id` (`hr:leave` -> `decide_leave`); an override is `iam` + `iam:override` ->
  `decide_override`. Non-IAM approvals are byte-unchanged and carry no `override` key in the response —
  pinned by a test that asserts the exact old shape.
- **Requester ≠ decider is structural**: `EFFECT_DENY` on `roles: ["user"]`, so deny-overrides beats
  even platform_admin's wildcard, and it fails CLOSED on an unresolvable requester. Both the dept-head
  and the company_admin self-approval attempts are pinned at 403.
- **Routing earns its keep, and a failing test proved it.** A `company_admin` cannot grant `hr_manager`
  at all — it lacks `reports.appraisal.confirm_evidence/cycle_admin/finalize`, which are
  `hr_people_ops`-only — so the ceiling refuses them at execution. That is exactly why hr-sensitive
  overrides route to the HR tier. The ceiling runs against the DECIDER, never the requester: the
  approver's authority is what backs an override.
- **An override never widens scope.** The requester still needs `role_grant · create` on the target, so
  a dept head cannot request one outside their subtree (403) and a non-member target is a 400. It
  routes past the sensitivity bound only — never the subtree bound, the elevated fence or the
  allow-list, each pinned.
- `automation_approvals.origin` widened to admit `'iam'`, following `0028`'s drop-and-re-add precedent
  (Postgres cannot ALTER a CHECK in place) and looking the constraint up BY DEFINITION, not by name.
- Two schema assumptions corrected the hard way, both caught by the migration failing in test: the
  catalog's `domain` is stored as `module_key`, and `permissions.id` carries no default.
- Five tally guards moved (282 -> 283 pairs, 267 -> 268 grantable) and one real gap closed: the new key
  was in no permission group, now `advancedOnly` alongside its sibling `core.role_grant.create`.
- Gates: override battery 16/16, catalog/group/ui-grantable suites 46/46.
### [0.24.0] - 2026-08-19 - IN PROGRESS (the self-scoped marker: the ceiling's durable mechanism)
- **`role_permissions.self_scoped` (migration `0114`)** replaces P2-08's interim "subtract the baseline
  `member` bundle" on the REQUIRED side of the grant ceiling. A (role, key) pair is marked when EVERY
  Cerbos ALLOW rule granting that key to that role is self-scoped (`resource.attr.X == principal.id`,
  or `variables.owns`). 21 pairs today: member 17, viewer 4.
- **Derived, never hand-listed.** `scripts/generate-role-bundles.mjs::computeSelfScoped` uses the
  predicate copied verbatim from `permission-arm-hazard-scan.test.ts::selfScopeField` — the hazard scan
  asks "can a flat perms mirror express this?" and the ceiling asks "is this authority over OTHER
  people?", which are the same question about the same rule shape. A policy edit moves the JSON and the
  diff shows it; `self-scoped-marker-parity.db.test.ts` fails if policies, JSON and DB disagree.
- 🔴 **The marker does NOT subsume the baseline argument — measured, not assumed.** Marker-only:
  `company_admin`→`member` 0 missing, but `org_unit_lead`→`member` **55 missing** and
  `hr_manager`→`hr_staff` 1 missing. That would have re-broken the dept-head surface. The two rules
  answer different questions, so both apply: the marker on the REQUIRED side, the baseline moved to the
  HELD side (a grantor is themselves staff, so passing on baseline reach confers nothing new). That
  placement also keeps the refusal message truthful — a missing key is one the grantor genuinely lacks.
- **Why the marker is still the better mechanism:** `hr.case.cancel` and `core.client.delete` both sat
  in `member`'s bundle; the subtraction removed both and only the first was self-service — the second
  was real tenant-wide reach and a live over-grant (§12.5). The parity suite pins `core.client.delete`
  as never-markable, on both sides of the chain.
- The sensitive gate applies the identical pair of rules, so the two guards cannot drift apart.
- Gates: marker parity 5/5, ceiling invariants 26/26, grant surface 14/14, `src/rbac`+`src/db` 925/925.
### [0.23.2] - 2026-08-18 - IN PROGRESS (the sweep busy-looped on the live box; three layers fixed)
- 🔴 **INCIDENT, self-inflicted and self-found.** Enabling `POSITION_SYNC_ENABLED` on the live box
  produced `IAM grant-expiry + position-drift sweep on: every 0ms` and platform sat at **~46% CPU**
  sweeping Postgres continuously. Nothing errored; `/health` stayed 200. A busy loop presents as
  healthy uptime, which is why it needed a log line to be noticed at all.
- **Cause, in three parts, all mine:** compose was given `${POSITION_DRIFT_SWEEP_INTERVAL_MS:-}`, and
  that form passes an **empty string** when the variable is unset; `config.ts` read it as
  `Number(env ?? default)`, and `??` does not fire on `""` while `Number("")` is `0`; and
  `startPositionMaintenanceLoop` accepted a 0 interval without complaint.
- **Fixed at all three:** `positiveIntFromEnv()` treats empty/NaN/<=0 as unconfigured; the loop
  REFUSES a non-positive interval loudly and returns an inert handle; compose carries a real default
  (`:-86400000`) so the container never receives a value the app has to guess about.
- **Also removed a duplicated env block** in `docker-compose.vps.yml` — the same `POSITION_*` block had
  been committed twice. Compose tolerated it (last key wins), which is exactly why it went unnoticed.
- Mitigated live before the fix shipped by setting an explicit interval; CPU returned to ~5%.
- Pinned by `src/admin/sweep-interval-guard.test.ts` (11 cases): the empty-string case is called out
  as THE incident value, and both a positive interval and a real configured value are asserted so the
  guards are not over-broad. The incident itself is the teeth proof — the 0ms behaviour was observed.
### [0.23.1] - 2026-08-18 - IN PROGRESS (four owner decisions, and a live over-grant closed)
- 🔴 **`member` could delete any client in the tenant — closed.** Found while preparing the
  sensitivity-flag review, not by a scan: `core.client.delete` sat in the BASELINE `member` bundle, and
  a live probe (a principal whose only grant was `member @ company`) returned EFFECT_ALLOW on client
  create/update/delete — no `owns` carve-out, and the handler passes no ownership attribute to narrow
  it. Soft-delete and audited, so recoverable, but real reach over a core business entity, and
  deployed. `member` now keeps create/update and loses delete (owner decision); `manager`/
  `company_admin` are untouched, which the new test asserts so the narrowing cannot over-correct.
- **HR runs joiner/mover/leaver end to end.** `hr_people_ops` gains `core.position.assign`/`.unassign`,
  resolving the §5.1-vs-§4.1 contradiction P2-06 surfaced (an `hr_manager` used to get 403 the moment
  `positionId` was present). `hr_staff` deliberately does NOT — `hr_people_ops` is the ACTING tier —
  and that refusal is pinned. A dept head's assignment becoming a REQUEST is the owner's chosen
  end-state and waits on P2-08 part B; direct assign stays live until then rather than leaving a gap.
- **Seven READ permissions are no longer `sensitive`** (`contract.read`, `identity_link.read`,
  `rollup.read`, `role_grant.read`, `invoice.read`, `it.account.read`, `hr.case.read`) — 107 -> 100.
  `hr.record.read` stays flagged (bulk personal data). The flag became load-bearing when P2-08's
  dept-head gate started routing sensitive-carrying roles as overrides, and flagging reads meant any
  role that can *view* a contract or a dashboard was refused. Two groups (`invoices_view`, `rollups`)
  lost their derived flag mechanically; both `_meta` counts were RE-DERIVED, never hand-edited.
- **The ceiling's baseline subtraction is now an explicit interim.** The owner ruled the durable form
  is a per-key catalog marker separating self-scoped keys from authority-over-others keys; the
  subtraction ships until that lands, and PERMISSION-CONTRACT §12.1 says so rather than leaving it
  looking permanent. `core.integration_connection.*` vs `core.client.delete` is the worked example of
  why a marker beats a subtraction: both sat in the baseline bundle, only one was genuinely self-scoped.
- Migration `0112` syncs the DB half (bundle row dropped, two added, seven flags cleared), asserting
  every delta with `GET DIAGNOSTICS` rather than trusting it.
- Gates: parity chain `src/rbac`+`src/db` **920/920**, `employees-jml` 15/15, the new live-probe suite
  9/9, `cerbos compile` clean, Cerbos restarted before every probe.
### [0.23.0] - 2026-08-18 - IN PROGRESS (IAM Phase 2: JML, positions, the grant surface, and the expiry sweep)
- **A hire, a transfer and a termination now move real authorization (P2-06).** Seven endpoints under
  `/api/:t/hr/employees` — list/detail/hire/patch/delete plus `transfer` and `terminate`. The §5.2 mover
  criterion is proven in its HTTP form against RUNNING Cerbos: after a transfer, zero `user_roles` rows
  point at the closed assignment, the OLD department's probe is 403, the NEW department's is 200, and
  `session_version` moved. Probed with a principal `assemblePrincipal()` builds from the rows the
  reconciler wrote — not from a role bundle, which cannot witness this at all.
- **The org-blob write pipeline is now ONE implementation** (`admin/org-structure.service.ts`), with the
  org PUT and the JML flows as its two callers. A transfer that moved a seat without moving the blob
  person node would be silently reverted by the next org edit's membership sweep.
- **Positions have an HTTP surface at last (P2-12 backend).** Until now a seat could only be created with
  raw SQL, so the JML flows had nothing to hire into. CRUD + the role-set composer + assign/unassign,
  with a dept head narrowed to their own subtree and `attachable-roles` returning refused roles WITH a
  reason rather than omitting them.
- **The grant/revoke surface (P2-08 part A).** `/api/:t/role-grants` over the `role_grant` kind:
  `unitAncestors` derived server-side from the closure (never from the body), every other invariant left
  to Cerbos or the choke point, and a position-managed grant refused as `managed_grant_not_revocable`
  rather than deleted and silently restored by the next reconcile.
- **`expires_at` finally means something (P2-09).** The column shipped in `0109` and no writer set it;
  P2-08 writes it and P2-09's sweep revokes on it, bumps the session and audits `role_grant.expired`.
  P2-05's drift sweep — built, never started — is on the same loop. ⚠ `assemblePrincipal()` still does
  not filter on `expires_at`, so the gap between expiry and the next tick is real and recorded.
- 🔴 **The ceiling could not pass the commonest grant in the system.** `company_admin` granting `member`
  was refused over three keys `member` holds only for SELF-SERVICE. A plain subset test therefore
  forbids granting the baseline role to anyone, forever — and the sensitive gate had the same defect
  (baseline `member` carries 11 sensitive-flagged keys). Both now subtract the baseline bundle. This
  relaxes a guard P2-04 shipped: `PERMISSION-CONTRACT` §12.1 records it as needing ratification.
- 🔴 **`targetUserId` was an attribute no handler could send**, so the self-assign and self-target DENY
  rules on `position`/`role_grant` were structurally unreachable. Added to the `Resource` type; the DENY
  now fires, proven against the strongest possible caller.
- 🔴 **The leaver flow would have disabled every leaver's login** — the "still employed elsewhere?" count
  ran under `withGlobal`, so RLS returned zero rows for everyone with no error. Now uses the
  `principal_lookup` policy. Caught by its own test going red first.
- ⚠ **HR cannot place, transfer or terminate anyone** — `assign`/`unassign` are `company_admin` +
  `org_unit_lead` only, which contradicts design §5.1. What shipped honours Cerbos and pins both
  directions; the owner call is recorded with a recommendation.
- **NOT built, and refused rather than faked:** the routed override (`decide_override` exists in neither
  the policy nor the catalog, so an above-baseline sensitive grant from a dept head returns a typed
  `override_required`); future-dated JML (the reconciler has no as-of axis); P2-07's MCP tools, so none
  of these capabilities meet the agentic-native bar yet.
- Migration `0111` (the joiner's natural key, which `0109` did not cover for principal-less candidates).
- Gates: `employees-jml` 14/14, `positions` 11/11, `role-grants` 14/14, `grant-expiry-sweep` 6/6,
  `grant-write-invariants` 26/26, `src/admin`+`src/rbac`+`src/db` regression, `tsc` clean,
  `lint:withtenants` + `lint:migration-rls` clean. **Not deployed** — the push credential in the working
  session had no write access to the repo.
### [0.21.2] - 2026-08-12 - IN PROGRESS (IAM-04 batch 4 + IAM-SEC-04 — 16 permission arms, and the scope guard generalised)
- **16 of the 17 kinds `team_lead`'s retirement made SAFE now carry a permission arm** (`activity`,
  `client`, `client_contact`, `comment`, `custom_field`, `deliverable`, `device`, `file`,
  `meeting_recording`, `member`, `notification`, `org_structure`, `pm_project`, `report_period`,
  `task`, `work_activity`) — purely additive, 45 of 60 kinds mirrored, zero decisions changed. Each
  carries an isolation case granting the permission with `roles: []`, so the role arm cannot be what
  answers; a dual-match where only the role arm fires passes every test and proves nothing.
- **`portal` deliberately NOT wired.** Its one non-wildcard rule names `client` alone, whose Cerbos
  condition is company-scope-only, so a generic mirror would allow at a scope the role arm refuses.
- **The hazard detector's Pattern C was widened (IAM-SEC-04).** It only ever scanned rules whose
  actions include the literal `"*"` — but the hazard is "a rule reachable at a scope the named role's
  condition would refuse", which has nothing to do with wildcards. `portal` was the counterexample
  it could not see. The widened sweep over 68 kinds surfaced 35 previously-invisible
  `group_executive` rules plus two genuinely open cases.
- 🔒 **The write-path scope guard now covers both directions.** `assignRole` restricted only
  `platform_admin`/`group_executive` to global scope; nothing stopped a `company_admin` minting
  `client@global` (company-only) or `org_unit_lead@company` (org_unit-only). Inert today ONLY because
  those kinds carry no mirror yet — which is where the rollout happens to be, not a safeguard.
  `GLOBAL_ONLY_ROLES` became `ROLE_SCOPE_CONSTRAINTS`, and rather than accept an eighth
  hand-maintained list, `permission-arm-hazard-scan.test.ts` re-derives it from `derived_roles.yaml`
  and fails if the controller's copy drifts. Teeth-proven: dropping one entry turns the refusal into
  a created grant (`expected 201 to be 400`).
- **Count assertions across the IAM guards are now derived, not pinned.** Five broke in one afternoon
  when another team legitimately added a module — none caught a defect. The rule applied: a TALLY is
  derived; an INVARIANT (`relationship === 15`) stays pinned, because a red there is the signal.

### [0.21.1] - 2026-08-11 - IN PROGRESS (HIER-3 — retire `team_lead`/`team`/`teams`, the contract half of HIER-1's expand/contract pair)
- **Migration `0103` closes what `0100` opened.** `user_roles.scope_type` is hard-narrowed to
  `global | company | org_unit | project` — `team`/`record` are DELETED, not merely unwritten:
  0103 restores 0100's own downgraded guards as hard `RAISE EXCEPTION`s (count-asserts zero
  `team`/`record` rows first) before narrowing both the scope_type CHECK and the per-scope shape
  CHECK. `teams`/`team_memberships` are DROPPED (0 rows live, count-asserted). The global
  `team_lead` role is deleted (cascades its `role_permissions` bundle); the 4 `core.team.*`
  catalog permissions are deleted (cascades any remaining bundle references) — catalog 230→226,
  grantable 215→211, distinct Cerbos kinds 61→60.
- **Every writer that could mint a `team`-scoped grant is removed in the SAME change** (the
  ticket's own lesson from HIER-1: values and writers come out together, or not at all):
  `core/teams.controller.ts` deleted outright (module wiring + its own test file), zero UI callers
  / zero live rows / zero other backend importers, per the consolidation plan's inventory.
  `testing/personas.ts`/`seed/personas.ts`'s `team_lead` persona reworked to `org_unit_lead` — an
  org-unit placement + an `org_unit`-scoped grant, so person-scope narrowing (not just raw-grant
  existence) is actually exercised by the fixture.
- **23 Cerbos policy files + `derived_roles.yaml` swept.** `team_lead` derivedRoles entries
  removed from every resource policy that named it; `resource_team.yaml` (the `team` kind) and the
  `team_lead` derived role deleted; the 5 `perm_pm_task_*` permission-arm roles' `team_lead`
  grants-exclusion clauses simplified back to plain global-or-company mirrors (the exclusion was
  built specifically for `team_lead`×`pm_task` and has nothing left to exclude once the role is
  gone). Live-probed post-restart: a `team_lead` grant now denies everywhere; `manager` and
  `org_unit_lead` decisions are unaffected.
- **`permission-arm-hazard-scan.test.ts` co-updated, not weakened.** `pm_task` (the IAM-04b pilot's
  original control kind) measurably moved HAZARDOUS → SAFE — its only-ever hazard was `team_lead`
  mixing, now gone — and drops out of the REGISTER test; `time_entry` replaces it alongside
  `hr_case` (an independent Pattern-B hazard, unrelated to `team_lead`, survives the retirement
  untouched, exactly as the HIER-01 consolidation plan predicted). PART 4's synthetic teeth-proof
  is rebased onto `client` (still genuinely unsafe today) instead of the retired role. The
  detector's own classification logic is byte-unchanged.
- **`docs/PERMISSION-CONTRACT.md` and `docs/FRONTEND-BFF-CONTRACT.md` updated in the same pass** —
  the `/api/:t/teams*` row is marked retired, the `team_lead`/scope-type "NOT frozen, actively
  moving" caveats in the permission contract are resolved to their landed state.
- **Zero authorization decisions changed for any REACHABLE grant** — every removed reach was
  provably unreachable (the HIER-01 measurement's whole premise): `team_lead` legitimately
  disappears from the permission-arm hazard register, which is a coverage reduction (fewer
  concepts to carry), not authorization drift.

### [0.21.0] - 2026-08-11 - IN PROGRESS (IAM Phase 1 — catalog, bundles, permission-arm rollout, the BFF endpoint)
- **Consolidated entry** for a two-day, many-ticket wave (`docs/superpowers/plans/2026-08-10-iam-*`,
  25+ per-ticket reports) that this changelog line summarizes rather than repeats. Full detail and
  re-derived numbers: `docs/PERMISSION-CONTRACT.md` (updated 2026-08-11 in the same pass as this
  entry).
- **The permission catalog is DB-persisted and boot-validated.** Migrations `0091`-`0101`: 215
  grantable + 15 relationship permissions (`0093`), six previously-ungrantable roles seeded
  (`0091`), a global-scope grant dedupe fix (`0092`), 936 role→permission bundle pairs across 20
  roles (`0094`/`0097`/`0098`), `company_admin`'s bundle widened 199→200 by DR-5's deliberate
  `reports.appraisal.read` grant (`0099` — the program's first authorization-widening decision, not
  a mirror correction), and the `org_unit` scope substrate (`0100`, expand-only: drops `team`/
  `record` from the `scope_type` CHECK, widens `scope_id` uuid→text) plus its closure table
  (`0101`). `ModuleContract.permissions` now fails boot closed on an uncatalogued declaration.
- **IAM-04's permission-arm rewrite reaches 28 of 61 Cerbos kinds** (2-kind pilot + 26 more:
  `agency_brief/campaign/creative_asset`, `chat_group`, `company`, `compliance_gate`, `contract`,
  `identity_link`, `invoice`, `knowledge_source`, `report_admin`, `rollup`, `rollup_recompute`,
  `service_assignment`, `user`, `webdev_change_request`, `webdev_provisioned_site`, `hr_record`,
  `agency_approval`, 7× `resource_search_*`) as an additive mirror beside existing role-name
  matching, which still decides every live authorization — proven identical by a parity suite and
  16→42 isolation tests granting the permission with `roles: []`. A real regression was caught and
  fixed before landing (`team_lead`'s dead `pm_task` grant would have flipped 403→200 on the first
  cut). A related, NOT-yet-fixed hazard is named in the contract doc: the wildcard-bleed shape on
  `platform_admin`/`group_executive`, which the hazard detector doesn't catch.
- **New BFF endpoint (IAM-05c):** `GET /api/:tenantId/authz/permissions` + `GET /api/authz/
  permissions` — scope-level effective permissions, ETag-cached and invalidated on
  `session_version`. Explicitly NOT a per-resource answer; see the contract doc §4-§5 before
  wiring a UI consumer.
- **A live defect found and fixed during the rollout (IAM-SEC-02):** `platform_admin`/
  `group_executive` were grantable at company/project scope through the generic role-assign
  endpoint even though both roles' Cerbos conditions match global scope only — a grant that would
  have been silently inert for Cerbos while still resolving into `principal.perms` at company
  scope. Closed at the source (`admin-identity.controller.ts`'s new `GLOBAL_ONLY_ROLES` guard),
  pinned by `global-only-role-scope.test.ts`.
- **CI promotion (IAM-07b):** three new static guards (Cerbos↔catalog alignment, groups↔catalog
  parity, a chain meta-test) wired into the `platform-nest` CI job ahead of the full suite.
- **Zero authorization decisions changed** for any existing user — every ticket in this wave
  carried a parity assertion (`role-permission-parity.db.test.ts`, `iam-215-boundary-pin.test.ts`)
  kept green throughout; the one deliberate exception (DR-5) was an explicit, named owner decision.

### [0.17.0] - 2026-08-07 - IN PROGRESS (a handoff no longer files a write behind your back)
- **The confirm-chip bypass is closed, and it was worse than "skips the chip".** `createHandoff` never
  sent `fileOnSuspend`, so it inherited the runner's default of TRUE: a handoff-driven `high_write` was
  filed into `automation_approvals` and **every decider notified** the instant the goal suspended, with
  zero owner confirmation. Documented as a deliberate scope cut in the ASST-23 design (the handoff click
  was treated as consent); the owner overruled it.
- The settling argument, kept because it generalises: clicking "hand off" is consent to RUN AN AGENT,
  not consent to THIS write with THESE arguments - which is what the chip shows before anything is
  filed. A modal at handoff time would have been consent to a blank cheque.
- **Reuse, not a second mechanism.** `harvestSuspendedIntent` writes the same three tables with the same
  redaction and TTL as the chat path, so the existing confirm/dismiss endpoints and card-state join
  handle it with ZERO changes - no new endpoint, no Cerbos rule, no migration. The safety property no
  longer depends on how the run was started.
- **Idempotency without a new column:** the synthesized `assistant_tool_calls.id` reuses the handoff
  row's own id (different table, no collision). A goal can suspend at most once, so "does a tool_call
  with this id exist" is an exact, race-safe already-harvested check - taken under the SAME per-thread
  advisory lock `sendMessage` uses, so a concurrent chat turn cannot collide on
  `assistant_messages`' `UNIQUE (thread_id, seq)`.
- Known UX latency, reported not fixed: a harvested handoff intent is correctly file-only-on-confirm and
  fully confirmable, but may not surface in an already-open thread until reload.

### [0.16.0] - 2026-08-06 - IN PROGRESS (ASST-23: the broker can propose a write, and confirm-before-file)
- **The broker write turn + a registry gate that refuses BEFORE the runner is contacted.** A turn naming
  an agent with an unregistered write tool gets a typed `tool_not_executable` refusal and the runner is
  never reached - the same "provably nothing ran" shape as wall 1, rather than discovering at execution
  time that the approval could never have executed.
- **An IMPORT-TIME guard against a confirm-chip bypass.** A `fileOnSuspend:false` goal routed through
  `supervisor` still files immediately (found and documented in ai-agents 0.6.0). Not reachable from the
  assistant - the broker rejects any agent absent from its mirror - but that safety was implicit in a
  table this work edits, so `assertNoDelegatingAgent` now runs at MODULE LOAD, not in a test: a test can
  be skipped, a module that refuses to load cannot.
- **`assistant_write_intents` (migration 0085)** - brand-new table, ZERO DML, so it is structurally
  immune to the RLS-backfill trap rather than defending against it. FORCE RLS with the
  `app_module_allowed('assistant')` conjunct matching its siblings.
- **Confirm/dismiss are owner-only**, and `create()`'s body was extracted into a shared
  `fileAutomationApproval()` so a confirmed row is shape-identical to a runner-filed one and the n8n
  path is untouched. Exclusivity is Postgres's own row-level locking, not an application
  check-then-write - proven with a genuine 8-way race, plus a confirm-vs-dismiss race (opposing terminal
  transitions are a different failure mode than N identical ones).
- **Found a defect in the design, not just the code:** the confirm design specified the claim as a
  single UPDATE that both nulled `tool_args` and `RETURNING`ed them - which returns NULL, so the confirm
  would have filed an approval with no arguments. Split into three statements in one transaction.
- D14-17 closed as **zero net-new registry entries**, proven rather than skipped, with 7 tests pinning
  the read-only surface so it cannot silently rot.
- **`lint:withtenants` read docblocks as code** (a JSDoc ` * ` prefix contains no `//`), which turned
  `main` red for four commits. Fixed the DETECTOR, not the comment - and verified it still bites by
  injecting a real multi-tenant call.

### [0.15.0] — 2026-08-06 · IN PROGRESS (the IdP can now vouch; ASST-21 agent roster + handoff)
- **The platform is one of two services entitled to mint `verified` hub principals** — it IS the IdP,
  so it is the one caller whose "this envelope belongs to a session I authenticated" means something.
  `core/hub-client.ts` presents `HUB_ASSURANCE_TOKEN` when configured; `hubConfigured()` now accepts
  EITHER token so a deployment setting only the elevated one is not reported `not_configured`.
- **The D14 agent re-drive needed no other change**: `approval-execute.ts`'s `resolveRedrivePrincipal`
  already resolves the requester's own link `WHERE verified_at IS NOT NULL`, so the platform's
  vouching conjunct holds by construction. The layered authorization above the floor is untouched —
  Cerbos still decides, and `requested_by == principal.id` still means only the original requester may
  resolve their own suspended call, never the approver.
- **Corrected four load-bearing comments** that this makes wrong, since in this codebase they are the
  design record: `approval-executables.ts` (the assurance blocker is GONE — the remaining one is the
  empty `RERUN_CAPABLE_HIGH_WRITES`, so a `requires verified assurance` denial from there is now a real
  misconfiguration, not the steady state), `modules/reports/index.ts` (still chat-unreachable, and
  why), and both `modules/search` sites (still refused, but by an explicit line rather than by
  impossibility).
- (Earlier, unreleased at `0047b`: **ASST-21** — assistant agent roster + handoff with an
  ADDITIVE-only transcript carve-out, `b9e0856`.)

### [0.14.1] — 2026-08-06 · IN PROGRESS (the loan approval path finally RUNS, and four things it found)

`0.14.0` shipped employee loans with 19 pure arithmetic tests, `tsc`, both lint gates and a green
`platform-nest` CI job — and yet the single most consequential step in the feature had never once
executed anywhere. `loan-decision.ts` is where the amortization schedule is BORN, and it only runs
inside the `automation_approval.decided` consumer: no unit test reaches it, no controller test
reaches it, the dev box was believed to have no database, and the server closes the dev auth header
(`AUTH_MODE=oidc`) so there was no token to drive it with. Three green signals, zero coverage of
approval materializing the rows that define what an employee OWES.

`loans.test.ts` closes that — 20 beats against live Postgres + Cerbos + Redis, driving the real
outbox→Redis→consumer pipeline, in the place that runs on every push. Writing it found FOUR defects:

1. **A latent one-day date shift.** `isoDate()` converted pg's `date` with `toISOString()`, which is
   UTC — so every timezone EAST of UTC reads the previous calendar day. A due date of 2026-09-01 came
   back as `2026-08-31`. Not live today only because the containers run with no `TZ` (UTC == local
   there), but it reproduces on any dev machine in Asia, and setting `TZ` on the container — which a
   Bali-based team would plausibly do to make logs readable — would have shipped wrong instalment
   dates to every borrower silently. The same mistake in `loan-decision.ts` was worse than cosmetic:
   approving at 02:00 local on the 1st would see UTC's "yesterday" (last month) and anchor the first
   instalment THIS month instead of next. Both now read LOCAL components via one shared
   `localToday()`.
2. **The detail endpoint was an existence oracle.** A colleague reading someone else's loan id got
   403 where an unknown id got 404, so the pair distinguishes "exists but not yours" from "does not
   exist" — letting an employee walk ids and learn which loans are real in their company. A denial is
   now 404, matching what the code's own comment always claimed.
3. **Withdrawing a request threw a 500.** `automation_approvals.status` has allowed only
   `pending|approved|rejected` since 0014 — a decider's vocabulary, with no word for the REQUESTER
   retiring their own row. Migration `0083` widens it to include `cancelled`. `rejected` was the
   zero-migration workaround and is wrong: it records that someone with authority refused, when
   nobody ever looked.
4. **My own test read through RLS and believed a real feature was broken.** `notifications` is in
   0001's FORCE-RLS sweep, so reading it with `withGlobal` (no tenant GUC) returns zero rows and
   reports success — indistinguishable from "notify() never fired". The fourth time this estate has
   lost time to that exact shape.

⚠ **`0083` exposes an EXISTING gap, deliberately left alone.** `cancelLeave()` never touches its
paired approval, so every withdrawn leave request since 0028 has left a permanently-`pending` row in
the approvals inbox. The migration makes the one-line fix possible; applying it to leave is outside
wave E, and backfilling the stale rows would have to guess which `pending` rows were withdrawn versus
still genuinely awaiting a decision.

Verification standing: 79 tests green across all five HR suites (hr, loans, loan-schedule,
wsd7-acceptance, module-hr-rls), `tsc` clean. Separately verified against the LIVE box: the deployed
Cerbos policy answers all 11 authorization questions correctly (including the borrower being denied
`hr_case:update` on his own loan), and the live schema enforces the third wall — an INSERT without
the `hr` scope is REFUSED rather than silently dropped, and `total_due = 0` is rejected by the CHECK
that made the degenerate-schedule bug a hard failure.

One finding recorded rather than changed: `resource_hr_case.yaml`'s `member` rule is MODULE-BLIND
(it tests tenant + assurance + subject, never `resource.attr.module`), so module scoping for a plain
member comes entirely from ModuleEnabledGuard and RLS. Nothing exploits that today — every hr route
passes `module: "hr"` — but a future controller authorizing `hr_case` under a different module would
not be objected to by that rule.

### [0.14.0] — 2026-08-05 · IN PROGRESS (employee loans: request → approve → amortize → repay)

Employee-portal wave E. An employee requests a loan, a human decides it on the EXISTING unified
approvals surface, and approval materializes an amortization schedule that repayments accrue against.

- **Migration `0081_hr_loans.sql`** — `hr_loan_requests` (the agreement) + `hr_loan_installments`
  (the frozen schedule) + `hr_loan_repayments` (append-only ledger), all three behind the same
  `app_module_allowed('hr')` third wall as the rest of the module, with tenant-scoped composite FKs.
- **`loan-schedule.ts`** — pure amortization + FIFO allocation, all arithmetic in integer minor
  units. 19 unit tests, no database. Two invariants pinned: the schedule sums to the principal
  EXACTLY (per-installment rounding is absorbed by the last row), and an overpayment surfaces as
  `credit` rather than a negative balance.
- **`loans.controller.ts`** — request/list/detail/cancel/repayment. Reuses Cerbos kind `hr_case`
  rather than adding `resource_hr_loan.yaml`, because a NEW policy file is not hot-reloaded through
  the bind mount and an unlisted kind is a silent DENY that reads like a logic bug.
- **`loan-decision.ts`** + an `automation_approval.decided` DISPATCHER in the module contract: that
  key allows one handler per module and hr now files two kinds of approval (leave, loans), so both
  appliers run in sequence and each no-ops on the other's payload.

Three things worth keeping in mind here:

1. **A member may request but never repay.** Recording a repayment authorizes as `hr_case:update`,
   an action the `member` derived role does not hold, so the employee who owes the money cannot
   declare it paid. Request/cancel/read use `subjectUserId` and match the member self-service rule.
2. **A degenerate loan closes early.** 1.00 over 120 months is 100 cents across 120 installments —
   the balance is gone after 100, and rows 101-120 would be `total_due = 0`, which `CHECK (total_due
   > 0)` rejects, failing the whole approval INSERT. Caught by the property-style test, not by
   inspection; `buildSchedule` now stops when the balance does, so the result may be SHORTER than
   the term and callers must read the returned length.
3. **Payroll deduction is a documented seam.** Wave D (payroll) is deferred, so `method:
   'payroll_deduction'` is selectable but nothing writes it automatically. When payroll lands it
   becomes the automated writer of exactly this ledger row — no shape change needed.

Impact is **`high`**, not leave's `medium`: this one moves money, so D14 suspends the agent/n8n path
for a human decision. MCP gains `hr.listLoans` + `hr.requestLoan`.

**UNVERIFIED:** the DB-dependent half. `tsc`, both migration lint gates and the 19 pure tests are
green; the HR integration suite needs live Postgres + Cerbos + Redis, which this box does not run
(server is truth). The approval→schedule path needs an on-server pass after deploy.

### [0.13.1] — 2026-08-05 · IN PROGRESS (APPR-01: per-approval detail route, backend half)

Closes a gap found during the mail build: emailed `automation_approval`/`agency_approval`
notifications carried `payload.href: "/approvals"` (the bare list) — a decider clicking the link
had to hunt for the row. `platform-ui`'s new `/approvals/[id]` needed an id-bearing href AND a
single-row read to resolve it against; both land here. **Caps at IN PROGRESS** — no deploy path
right now (Actions billing-blocked), so nothing below is DEV-VERIFIED against the live box.

- **Two new single-row reads**, same authorization as the list they sit next to (no new model, no
  weaker gate — verified with a cross-tenant-404 + "same refusal as the list" test on each):
  `GET /api/:t/automation-approvals/:id` (`core/automation-approvals.controller.ts`, fetch-before-
  authorize so an hr-origin row's `module='hr'` branch of `resource_automation_approval.yaml`
  still applies, mirroring the existing `decide()`'s own pattern) and
  `GET /api/:t/modules/agency/approvals/:approvalId` (`modules/agency/agency.controller.ts`, same
  fetch-before-authorize shape, same `read` action the `pending`/`decided` endpoints already use).
  Both return camelCase rows (`workflowId`/`toolName`/… and `campaignId`/`campaign`/…) — a new
  shape, not a mirror of the existing snake_case list rows, since nothing else read it yet.
- **`payload.href` fixed at all FIVE `approval.requested` emission sites** (the same five MAIL-06
  enumerated): `core/automation-approvals.controller.ts` `create()`, `modules/hr/hr.controller.ts`
  `fileLeave()`, `modules/search/search.controller.ts`'s Google-Ads suspend path, and
  `modules/agency/agency.controller.ts`'s `createApproval()` + `submit()`. Each now emits
  `` `/approvals/${id}` `` instead of the bare `"/approvals"` — pinned with a test per site
  reading the real `notifications.payload` row.
- No Cerbos policy change — both new reads reuse the `read` action the list endpoints already
  authorize against.



The backend for the client portal — the client side as a **separate interface** (owner decision,
2026-08-04). Plan + runbook: `docs/plans/2026-08-04-client-portal-deployment.md`; contract §16 of
`docs/FRONTEND-BFF-CONTRACT.md`.

- **Migration `0075_client_portal.sql`** — `contracts` (versioned, with a term and a value,
  `supersedes_id` for re-issues), `contract_signatures` (one row per party, UNIQUE — the
  `scope_signoffs` shape reused deliberately rather than a second signing idiom), and
  `invoice_payments` (an append-only money ledger behind `invoices.status`, which had a status enum
  and nothing else: no amount, no date, no method, no reference, no proof, and therefore no partial
  payments and no balance). Head was 0074; `0058`/`0059` remain the reports program's orphaned
  reservation gaps. Pure DDL — no backfill, so the `migration-backfill-rls-trap` does not apply.

- **`portal-scope.ts`** — the portal's isolation kernel, extracted from `PortalController` because the
  portal grew from 3 routes to ~20 across four controllers and a rule re-derived four times is a rule
  that will disagree with itself.

- **TWO LATENT IDOR GAPS CLOSED while extracting it**, both of the same shape — a value resolved and
  then not applied:
  - `decideGate` and `scopeSign` both resolved `projectIds` and **never used it**. The read paths
    (`listRuns`/`getRun`) carried the project predicate, so a project-scoped contact could not SEE a
    run outside their project — but could DECIDE its gate or SIGN its scope, addressable by one id
    with no listing step.
  - `client_contacts.capability` (`signer`|`viewer`) existed since 0072 explicitly so that "contacts
    who WATCH but must not SIGN" was expressible, and **nothing ever read it**: every invited
    stakeholder could countersign a scope agreement. Now enforced on both signing paths, while a
    viewer keeps feedback and payment (paying is not signing).

- **Portal BFF, three read/write controllers**: `portal-workspace` (overview, projects, project
  detail, milestones, timeline, deliverables), `portal-commerce` (invoices, payment-with-proof,
  contracts, e-signature, and the portal's own scoped file download), `portal-profile` (profile,
  own-details PATCH, change-request). Client-safe by construction, not by filtering: individual tasks,
  effort/cost, and the raw `activities` log are structurally absent, and the timeline is a UNION over
  client-visible OBJECTS so a new internal event type cannot leak into a client's feed by default.

- **Realtime (`portal-live.service.ts` + `portal-stream.controller.ts`)** — the first SSE in this
  platform and the first long-lived connection served to external parties. **A frame carries a topic
  and a timestamp and nothing else**; the browser's reaction is to refetch through the
  ownership-enforcing BFF, so authorization still happens exactly once where it already worked and a
  fan-out filtering bug costs a wasted refetch rather than a disclosure. Tails the existing Redis
  Streams with a plain `XREAD` from the tail (at-most-once, no consumer group — joining the
  `in-process-platform` group would have STOLEN entries from module dispatch). Owns its own Redis
  connection with its own `error` listener: `getRedis().duplicate()` would have constructed the shared
  lazy client purely to clone its options, and that client has no error handler — which surfaced
  immediately as an "[ioredis] Unhandled error event" on a machine where `REDIS_URL` points at a
  Redis that is not running (every dev box). 9 unit tests, no infrastructure needed.

- **`contracts.controller.ts` — the staff counterpart**, shipped in the same change because without it
  the portal's contracts section is permanently empty and a client-recorded payment can never leave
  `pending`. Draft → send → countersign (owner-only, deliberately narrower than `company_admin`), plus
  the payment confirm/reject decision that **refuses self-confirmation** and derives
  `invoices.status='paid'` from the confirmed ledger rather than from the request.

- **Cerbos**: `resource_portal.yaml` gains `pay` + `update_profile` (each its own action, so one can be
  revoked without the other); **new** `resource_contract.yaml`. A new policy file has been observed not
  to hot-reload through a bind mount, and an unloaded policy DENIES silently — so `deploy.yml` now
  restarts Cerbos explicitly after syncing policies.

- **Two client-facing notification hrefs corrected** (`client-notify.ts`, `pipeline.controller.ts`):
  both pointed at bare `/portal` for run-specific events, which now lands on the dashboard rather than
  the thing that needs the client. Both deep-link to `/portal/approvals/:runId`.

- **`files` target kinds** gain `contract` and `invoice_payment`. Note this grants a client nothing:
  the staff upload route re-authorizes against the parent kind, which the `client` role does not hold.

**Verification:** `tsc --noEmit` clean; `portal-live.test.ts` 9/9. `portal-dashboard.test.ts` (25
DB-backed isolation/capability cases, incl. cross-client 404s, viewer-cannot-sign, overpayment refusal,
and the download IDOR) is **written and typechecked but UNVERIFIED** — the local Postgres/Cerbos pair is
deliberately off (the server is the source of truth); it runs in CI.

### [0.11.0] — 2026-08-04 · PROTOTYPED (the regression test the seal-hash fix shipped without)
Recorded after the fact for the `reva/ui` half of this version; the concurrent session's client-portal
/ pipeline work and migration `0074` also land under it. See `Alpha 01.010.0029a`.

- **`report-seal.hash.test.ts`**, from `reva/ui`. `canonicalStringify` mishandled `undefined`:
  `JSON.stringify` omits an undefined-valued property when writing JSONB but returns the VALUE
  `undefined` when called on it directly, which interpolates as the literal text `"undefined"`. So a
  freshly-built document hashed as `..."warnings":undefined...` while the same document re-read from
  storage hashed as nothing at all — `seal_hash` could never be reproduced, for essentially every
  sealed period. Because a tamper check that never reproduces is indistinguishable from one that
  caught tampering, the failure presented as a permanent false "these rows were altered".
- Both branches had fixed the code independently and identically. **What this adds is the test**, not
  the fix — the fix shipped unverified. Main's implementation was kept through the merge because it
  additionally handles `toJSON()` (a `Date` would otherwise hash as `{}`), which reva's did not.

> `0.9.5` and `0.10.0` have no entries — see the ledger-gaps note in `Alpha 01.010.0029a`.

### [0.9.3] — 2026-08-03 · PROTOTYPED (two endpoints that described the wrong world)
- **`GET /api/roles` returned every company's role rows.** Per-company roles share their NAMES across
  companies, so the assign-role picker rendered `manager` ten times and `company_admin` three times
  with nothing to distinguish them — and nine of those ten grant a role row owned by a different
  company. Now takes an optional `tenantId` and narrows to `company_id IS NULL OR company_id = $1`.
  Optional, so tenant-less callers keep working; membership-checked when passed, so it cannot be used
  to enumerate the roles of a company the caller has nothing to do with.
- **`automation/status`'s `n8nUrl` was the in-cluster base.** The UI turns that field into the "Open
  in n8n" link, so it was handing browsers `http://n8n:5678` — a name that resolves only inside the
  compose network. The console reported the service healthy and listed its workflows the whole time,
  which is why it went unnoticed. Split out `config.automationPublicUrl`
  (`AUTOMATION_PUBLIC_URL`); `n8nUrl` is now that value, omitted when unset so the UI hides the
  button rather than rendering a dead link, and the config panel shows both values labelled.
  Deliberately NOT inside `config.services` — that object is indexed by system name, so an extra key
  there would read as one more probeable service.

Verified: `tsc --noEmit` clean; `admin-systems` suite 24 pass. The pre-existing `n8nUrl` assertion
(`toContain("/n8n")`) had been passing only because this suite's `AUTOMATION_URL` happens to contain
that substring — replaced with one that asserts the public origin is used, that it differs from the
reported in-cluster base, and that the field is absent when unconfigured.

### [0.9.2] — 2026-08-03 · PROTOTYPED (effective module set, one query)

- `enabledModuleKeys(tenantId)` in `modules/registry.ts` — the SET form of the enablement rule
  (`enabled_modules` UNION active `service_assignments`). **`isModuleEnabled` now delegates to it**,
  so the OR-clause exists in exactly one query instead of two hand-written copies that can drift
  (the failure mode being a served tenant authorized on one path and denied on another).
- `GET /api/:tenantId/modules-enabled` — the effective set for one company. Membership-gated (403
  without a membership or a global `platform_admin`), not `authorize()`d: it is metadata about which
  surfaces exist, needed by every page a member can already open.
- The rewritten query was diffed against the old per-key `EXISTS` form on the live `gda-aicenter`
  database for all three companies — identical results, including the empty case (`{}` → no rows →
  `[]`, so `isModuleEnabled` stays false).

Verified: 8 unit tests (4 new, covering the membership branches with the registry mocked),
`tsc --noEmit` clean. The DB-backed paths are covered by the hr/reports suites against live PG,
which were **not** run — no local Postgres by standing decision.

### [0.9.1] — 2026-08-03 · PROTOTYPED (module catalog endpoint)

- `GET /api/module-catalog` (AuthGuard, no `authorize()`, deliberately **no** `ModuleEnabledGuard`) —
  the modules **compiled into the running build**: key + `uiManifest[0].label` + owned paths. The
  registry is a compile-time artifact, so this is tenant-agnostic; per-tenant enablement stays in
  `isModuleEnabled()` at each module's controller. Gating the catalog on enablement would recreate the
  very disappearing-row bug it exists to fix (see platform-ui `0.10.1`).
- No migration, no schema change, no behaviour change to any existing route.

Verified: 4 new unit tests, `tsc --noEmit` clean. The endpoint has **not** been driven at runtime —
the deployed `alpha-01.005.0015a` image predates it.

### [0.9.0] — 2026-08-03 · PROTOTYPED (IT network discovery + the device write half)

Migration `0071`. **The reported bug was not a bug.** "IT > Topology doesn't show all the devices in
the network" — measured against the real office network the same day: SSID `GDA`, `10.10.0.0/22`,
**~58 live hosts** behind a UniFi OS gateway at `10.10.0.1`. The ERP held **8 rows**, all hand-seeded
fiction on a `10.0.x.x` range that does not exist here, and a codebase-wide grep for
UniFi/SNMP/ARP/mDNS discovery returned **zero hits**. The feature never existed.

- **The ERP cannot poll the controller — verified, not assumed.** `10.10.0.1` is RFC1918 behind office
  NAT; `curl` from `gda-aicenter` returns HTTP `000`. Discovery is therefore a **push**:
  `POST /api/:t/it/discovery/report`, fed by `it-site-collector` (**not built** — blocked on a
  read-only UniFi API key and an always-on office host).
- `GET /api/:t/it/topology` — server-computed `{ devices, links, lastRun }`. `lastRun` is load-bearing:
  a **dead collector** and an **empty network** otherwise render identically.
- `PATCH` + `DELETE /api/:t/it/devices/:id` — the edit/delete half `0019_it_devices.sql` and
  `lib/it.ts` both promised and that was never built. `deleted_at` was filtered on by every query and
  written by nothing, so devices were immortal.
- **Status is now derived** from `last_seen_at` freshness (dark-by-default reaper). Nothing had ever
  called the heartbeat endpoint, so every UI-registered device kept the DB default `unknown` forever
  and rendered grey.
- New tables `it_device_links` (resolved edges) + `it_discovery_runs` (audit/staleness), both
  FORCE-RLS; the classify backfill is wrapped per tenant so it cannot silently no-op.

Three measured facts drove the design: **MAC is not an identity** (~60% of observed MACs are
randomized, so upserts key on UniFi's stable client id); **ICMP undercounts 5×** (12 of 58 hosts
answer ping, so liveness comes from the controller's client table, never a probe); and **BYOD is
counted, never stored** — ~25 of the 58 hosts are personal phones whose hostnames name staff outright,
so persisting them would build a presence log of named employees, which CLAUDE.md forbids before legal
Gate 1. Classification is recomputed server-side so a mis-set collector cannot launder them in.

Discovered rows carry an `overrides` layer so an operator's correction survives the next poll instead
of reverting ~5 minutes later. Seed fiction is now off by default (`SEED_DEMO_DEVICES=1`) and labelled
`demo-fixture`.

Deliberate deviation from the design doc: ingest authorizes on the existing Cerbos `create` action,
not a new `discover` one — a new action is a silent DENY until Cerbos restarts, and `create` is
already scoped to `company_admin`/`it_staff`.

Verified: 34 IT tests (20 pure + 14 against live Postgres + Cerbos incl. `0071`); full suite
2628 passed / 4 skipped / 0 failed; `tsc` clean; both migration lints clean. Carried forward: the live
tenant's 8 seeded rows still need purging (per-tenant SQL in the design doc §12).

### [0.6.3] — 2026-07-27 · PROTOTYPED (systems-console write levers)
- **NEW `PUT` + `DELETE /api/admin/gateway/config`** — proxies the gateway's new config-write route.
  The gateway owns validation/bounds/persistence; this layer re-throws its 4xx VERBATIM (400 bounds,
  400 non-writable key, 409 can't-take-effect) so a rejected value explains itself instead of
  collapsing into "gateway unreachable". `editable` on each ConfigField is driven by the gateway's own
  `writableKeys`, so this layer can never offer a save the gateway would refuse — and an older gateway
  yields a read-only page automatically.
- **NEW `POST /api/admin/automation/workflows/:id/activate|deactivate`** — n8n Public API, returning
  n8n's own resulting state. Gated to `isElevated`, deliberately NARROWER than the `isItOrElevated`
  read-only canvas: deactivating silently stops business automation with no other signal.
- **NEW `POST /api/admin/automation/bridge/:entityType/replay`** + `replayBridgeDeadLetters()` — moves
  dead-lettered entries back onto the source stream for redelivery. Re-adds BEFORE deleting, so a
  crash duplicates (which the at-least-once bridge + n8n's envelope-id dedupe already handle) rather
  than dropping. Refuses any stream the bridge isn't configured to watch, so an arbitrary Redis key
  can't be targeted through the route. This is the sanctioned "retry a failed automation": n8n's
  Public API has no execution-retry route, and re-running from the real input beats resuming a
  half-finished run.
- 723 tests green on live PG + Cerbos (+15: 6 admin-systems write cases, 9 new `bridge-health` unit
  tests covering the replay ordering guarantee, NOGROUP-vs-real-error, and fail-soft reads).

### [0.6.2] — 2026-07-27 · PROTOTYPED (systems-console depth: real config projections + 6 new admin reads/writes)
- **Root cause of three thin consoles:** `connectionConfig()` returned only `{url, tokenConfigured}`
  for every system except `bot`, so the Gateway/Hub/Automation "Configuration" cards were a two-row
  descriptor forever — and the Gateway page's "Provider chain" card looked for a config field keyed
  `providers` that nothing ever emitted, so it showed its empty state permanently. `GET
  /api/admin/:system/config` now returns a REAL projection per system (`gatewayConfigFields` /
  `hubConfigFields` / `automationConfigFields`), with the honest connection descriptor **appended,
  not replaced**, and every credential still `kind:"secretPresence"` (presence only).
- **NEW `GET /api/admin/gateway/detail`** — proxies the gateway's new `GET /admin/config`: chain in
  failover ORDER + live breaker state, provider inventory, budget breakdown **incl. per-tenant
  spend**, reliability tuning, security/topology posture.
- **NEW `POST /api/admin/gateway/dr-mode`** (`isElevated`) — WS9 D15 failover lever, proxied so the
  gateway token never reaches the browser. It raises the daily cap, so it is a platform-admin action.
- **`GET /api/admin/gateway/egress-audit` extended** — `?limit&provider&capability&decision` and the
  block taxonomy carried as structured `{capability, ok, blocked, redactions, latencyMs}` instead of
  being flattened into the free-text `detail`. Legacy fields retained.
- **NEW `GET /api/admin/hub/detail` + `GET /api/admin/hub/audit`** — the hub's posture block and its
  §8 tool-call decision trail. The audit had been written to JSONL and was readable nowhere.
- **NEW `GET /api/admin/automation/executions`** — n8n run history with `workflowId` resolved to a
  name + `durationMs`. The executions list was already being fetched and then discarded except for
  one "last run" cell per workflow.
- **NEW `GET /api/admin/automation/bridge`** + `src/events/bridge-health.ts` — event→n8n bridge
  delivery health (per-stream backlog, dead-letters, oldest-pending age, bridged event allow-list).
  A stalled bridge silently stops every event-triggered workflow while the workflow list still reads
  "active"; nothing in the console could show that. Fail-soft: Redis unreachable / no consumer group
  degrades to a per-stream note, never an exception.
- 708 tests green on live PG + Cerbos (admin-systems suite 17, +9 new cases).

### [0.6.1] — 2026-07-27 · PROTOTYPED (bot-proxy honesty fixes)
- **`botCall` swallowed 404s:** only a 400 was surfaced verbatim; every other non-OK status became
  `502 bot admin unreachable`. So the bot correctly answering `404 {"error":"unknown chat (no stored
  messages)"}` made the Chats tab report the bot as DOWN. 404 is now surfaced as a `NotFoundException`
  carrying the bot's own message. Found because the assertion covering it had never actually executed —
  see the stub fix below.
- **Status probe treated "unknown" as a real session:** `admin-systems.controller.ts` did
  `typeof h.session === "string" ? h.session : undefined`, and the bot's `/health` placeholder for
  "no session event observed yet" is the literal string `"unknown"` — truthy, so the fallback to the
  authoritative `/admin/session/status` never fired and the ERP pill showed UNKNOWN on a WORKING session.
  Now `"unknown"` is treated as missing.
- **Test-harness fix (`bot-admin.test.ts`):** the bot stub matched the thread route with
  `url.endsWith("/messages")`, which is false once `?limit=2` is appended — the request silently fell
  through to the chats-LIST branch, so the thread assertions were validating the wrong response and every
  assertion after the first was dead. Stub now matches on the path. New coverage: `/health` reporting
  `session:"unknown"` must still resolve to WORKING via the fallback.

### [0.6.0] — 2026-07-24 · PROTOTYPED (bot-admin + agents intelligence proxies)
- **Workstream A+B admin proxy layer (design §2.4 + §3.3):** NEW `admin/bot-admin.controller.ts` (`@Controller("api/admin/bot")`), isElevated-gated,
  proxies wa-chat-bot's `/admin/*` routes with fail-soft (bot unreachable → 502, unconfigured → 404). Routes: POST session/start, GET session/status,
  GET session/qr (Cache-Control: no-store), POST session/{stop,logout,restart}, GET/PUT groups (validates `{groups:[…]}` before forwarding),
  PUT config (`{key,value}` allow-list `{postToGroups,managementGroupId}` → 400 otherwise). Extracted `isElevated` helper to shared `admin/elevated.ts`.
- **Real agent-runner proxy (vs. old hardcoded stubs):** `intelligence.controller.ts` now makes live HTTP calls to agent-runner service. Config: `services.agents
  = {url: AGENTS_URL, token: AGENT_RUNNER_TOKEN}`. Routes: `GET /api/:t/agents/goals` (tenant-filtered, `authorize(activity read)`), `POST /api/:t/agents/goals`
  (isElevated, idempotently upserts platform self-link `identity_links(provider='platform', external_id=userId)`, calls runner `POST /goals` with envelope),
  `GET /api/:t/agents/goals/:goalId` (detail + blackboard + run summaries, tenant-pinned), `GET /api/:t/agents/runs/:runId` (full run + steps, isElevated only —
  transcript can carry user-triggered tool output). `probeStatus("agents")` now hits `/health` real-time; `connectionConfig("agents")` no longer says "CLI/library".
- **Not deployed yet:** nest endpoints verified against running agent-runner (pipeline+gateway working end-to-end per design spec §3.2).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. Core schema (FORCE RLS), ModuleContract + custom fields, Cerbos RBAC, OBO/identity links,
  rollups, agency vertical, event backbone (outbox→Redis Streams). ~92 dev tests.
- **Unreleased / next:** identity writes, org-structure endpoints.

## platform-ui
### [0.28.5] - 2026-08-21 - IN PROGRESS (AGN-3: a reader that swallowed everything, and the rule now pinned)
Readiness-bar **criterion 5** — "Explicit refusal ... Never an empty list that reads as 'no data'",
whose stated failure signal is literally "403/404 collapsed into `[]` by the reader". The plan's action
item 3 says to sweep every `safe()`/`skipMissing()` call site, and records what the defect already
cost: **the client portal told staff "your kickoff is being processed"** when the read had been refused.
- **The audit found SIX near-duplicate helpers with different rules**, which is how they drifted apart
  unnoticed: `adminData.skipMissing` (404/405 — correct), `people.safe` (**a bare `catch {}`**),
  `meetings`/`pipeline`/`webdevChangeRequests` (404 + **403**), `portal-data` (404 + 403, deliberate
  and documented in-file for staff browsing `/portal`).
- **`people.ts` fixed**, because its defect needs no design decision: the bare catch treated a 5xx, a
  network timeout, a JSON parse error and an outright bug in that file identically to "there is no
  such row" — across all seven panels of the person page. An empty panel is a CLAIM ("this person has
  no tasks") made on evidence that says nothing of the kind. Narrowed to `adminData`'s shape: absence
  degrades, everything else reaches the error boundary and gets reported.
- ⚠ **403 is still degraded, deliberately and now tracked.** Making a denial explicit needs somewhere
  to render it (action item 4, "one component rendering a typed deny reason"). Rethrowing it today
  would swap a quietly-empty panel for a crashed page: worse for the viewer, no more honest.
- **`readerDegrade.test.ts` pins the rule by sweeping the SOURCE**, not by calling the helpers — each
  is private to its module, so a behavioural test reaches only what a module exports, while a source
  sweep also catches the seventh copy pasted from the worst existing one. Positive control first (a
  sweep matching nothing would pass vacuously), no bare catches, every 403-degrader on an allow-list
  WITH a reason, and no STALE entries — so a fixed file cannot shelter a regression behind an old
  exemption. That last check caught my own list wrongly naming `webdevProvisionedSites-data.ts`, which
  is in fact a model implementation; it and `it-accounts.ts`'s discriminated
  `ok | unavailable | forbidden` are what the remaining four should converge on.
- Gates: 5/5 new; platform-ui `src/lib` regression **1877/1877 across 71 files**; `tsc` clean.
- ⚠ Housekeeping note: `0.28.0`–`0.28.4` have **no entries in this file** (the row in MODULES.md
  moved without them). Not backfilled here — that is other sessions' work to describe, and inventing
  it would be worse than recording the gap.
### [0.27.0] - 2026-08-20 - IN PROGRESS (P2-10 / P2-11 / P2-12-FE: the three Phase 2 surfaces)
Shared layer first, because all three write the same endpoints: `lib/iam.ts` (readers),
`lib/iamActions.ts` (every write plus ONE translation of the typed refusal vocabulary),
`components/iam/IamAction.tsx` (one control, three outcomes). A per-page copy of "POST, then humanize the
refusal" is three chances to read `ceiling_exceeded` differently, and that vocabulary IS the contract.
- 🔴 **THE REFUSALS ARE THE FEATURE.** `assignment_request_required` and `ceiling_exceeded` /
  `override_required` are not failures — they are the server telling the operator what to do instead. Both
  render as GUIDANCE with the follow-up control attached ("Propose instead", "Request override",
  prefilled), in a third outcome style that is deliberately not red and deliberately not announced with
  `role="alert"`. Colouring guidance as failure teaches an operator the system is broken while it is
  working exactly as designed. The override is also reachable standalone: someone who already knows the
  grant is above their ceiling should not have to trip over the wall to find the door.
- **P2-12-FE `/organization/positions`** — the composer NEVER filters: `attachable-roles` returns
  unattachable roles WITH a reason and they render disabled-with-reason. Orphaned seats sort FIRST (their
  holders' access is FROZEN — escalation, not a fix), vacant next; a seat with no role-set says "confers
  no access" in the row, because that state looks finished in a list.
- **P2-11 `/organization/access`** — subtree roster, seats, and per-person grants with PROVENANCE. A grant
  with `revocable: false` gets NO revoke control at all rather than a disabled one: the reconciler would
  restore it and the operator would conclude the UI lied. Effective access is scope-level and the page
  says so in words — IAM-05c's caveat is real, and a page implying it could answer "may they edit THIS
  document" would be confidently wrong some of the time.
- **`scope: "subtree"` is surfaced as a banner on both pages.** It means the server narrowed the list to
  the caller's lead units; rendering it as the whole company tells a department head that seats they
  cannot see do not exist.
- **P2-10** — hire (position optional; the message says which of the two happened, because a record with
  no seat confers nothing and no login), transfer (reports grants added AND removed — "granted 2" alone
  reads as a promotion), terminate (requires a reason and a confirmation that states what will actually
  happen; the endpoint accepts a bare call, but the least reversible action in the product should not be
  one click from a table row). `/hr/people` gains an Employment column reading **"No record"** rather than
  a blank, and counts the gap — that gap is exactly what P2-15's backfill closes.
- **Nav lists both new pages for `people.directory`, NOT `admin.access`.** A department head's authority
  comes from holding a lead position, which is not a capability `lib/rbac.ts` can test; gating there would
  hide the surface from exactly the person this wave was built for. The pages render the server's refusal,
  which is the real boundary.
- Gates: `iam.test.ts` 10/10 (ordering and degradation — the two decisions that go invisible once they
  work); full UI suite **2329/2329** over 148 files; `next build` clean with all four routes in the table;
  `tsc --noEmit` clean.
### [0.26.0] - 2026-08-19 - IN PROGRESS (P2-14: the IT accounts console)
- **`/it/accounts`** — the worklist ("who still needs a login, whose leaver login is still enabled") plus
  provision / disable / enable / reset-password, against P2-13's real endpoints. Default view is
  **what needs action**, not the full staff list: an operator opens this page to fix something, and a
  full roster buries the three rows that need them. `?all=1` shows everyone.
- 🔴 **`listAccounts` is the ONE reader in this codebase that does not degrade to `[]`.** Every other
  reader returns an empty array on 403/404 so a page can ship ahead of its backend. Here an empty list
  asserts "everyone has a login" — the claim the backend refuses to make with a typed 503 — so the reader
  returns a DISCRIMINATED result (`ok` | `unavailable` | `forbidden`) and the page renders `unavailable`
  as a warning that says, in words, that this is not a statement that everyone has a login. Three layers
  saying the same thing on purpose, because the failure is silent and reassuring.
- 🔴 **A CONTRADICTION IN THE IT LAYOUT, found while wiring the tab.** The layout gated the whole console
  on `isModuleOnForActiveCompany("it")` — correct for Devices/Topology/Workflows, whose controller is
  `ModuleEnabledGuard("it")`. But P2-13's accounts endpoint is deliberately NOT module-gated, precisely so
  login management does not vanish for a company with the module off while its people still need logins.
  Leaving Accounts under the blanket gate would have re-imposed in the UI exactly what the backend was
  built to avoid, and it would have failed in the reassuring direction: "IT module disabled" instead of
  "three leavers can still log in". The gate is now per-tool (`ITModuleGate`), and the tab strip renders
  always — hiding it would hide the one tool that still works.
- **The initial password is held in client state and the page does NOT refresh under it.** There is
  exactly one copy of it in existence; `router.refresh()` runs only after the operator dismisses the
  panel, the panel says plainly that it will not be shown again, and nothing writes it to the URL,
  localStorage, or a timer-dismissed toast. Reset requires a REASON before it will submit — the backend
  accepts null, this surface does not, because resetting someone else's password is the action most likely
  to be questioned later.
- `state` and `actionable` are used exactly as the server computed them. Re-deriving "needs attention"
  here would be a second implementation that drifts, and the direction it drifts in is a leaver the
  console quietly stops flagging.
- Employment status renders `—` when the backend returns null (the HR module is off for that company),
  never "active" — mirroring the backend's own refusal to claim `leaver_still_enabled` without real data.
- Gates: `it-accounts.test.ts` 10/10 (incl. four cases pinning the no-degradation rule); full UI suite
  2319/2319 after fixing a design-token violation my first CSS introduced (`var(--erp-danger, #hex)` —
  the guard caught the hardcoded literal; the real token is `--status-critical-fg`); `next build` clean
  with `/it/accounts` in the route table; `tsc --noEmit` clean.
### [0.25.1] — 2026-08-10 · IN PROGRESS (IAM Phase 1 mirror corrections — DR-6, DR-7, a capability-map defect)
- `lib/rbac.ts` corrected against re-derived Cerbos ground truth: `it_admin` loses
  `company.manage` (DR-6 — zero Cerbos overlap on `resource_device.yaml`, a dead-button
  over-claim, 1 live holder); `hr_staff`/`search_staff`/`reports_staff` gain `people.directory`
  (DR-7 — `resource_member.yaml`'s `module_staff` rule grants it unconditionally; 0 live holders
  today, a pre-staffing fix).
- `lib/rbac-capability-map.ts` drops `hr.case.cancel` from `hr.manage`'s permission set — a real
  defect, not an owner decision: no Cerbos rule ever granted `cancel` to `module_manager`/
  `company_admin`, so the capability was silently unsatisfiable for the two roles that hold every
  other member of the set unconditionally.
- Zero Cerbos changes; mirror-only. 6 new pinning tests plus the pre-existing 547-pair
  `rbac-capability-parity.test.ts` stay green. Full program context:
  `docs/PERMISSION-CONTRACT.md`.

### [0.20.0] — 2026-08-07 · IN PROGRESS (the sidebar collapses to a 64px icon rail)
- Merged `fadhil/ui` (1 commit, forked 163 commits back). Expanded mode gets collapsible nav groups;
  collapsed mode swaps renderer entirely - a 64px rail with one glyph per group, children in a
  floating flyout, labels as hover/focus tooltips. ~12 icons stand in for ~35 rows.
- State lives in its own **`gaiada_sidebar`** cookie, not the `gaiada_prefs` blob, so the toggle
  writes it client-side without round-tripping or clobbering density/width/theme. Stamped onto
  `<html data-sidebar>` server-side so a collapsed rail never flashes open.
- Below the drawer breakpoint the off-canvas panel still wins (touch has no hover) and the collapse
  button hides, so the two never fight.
- **Merge resolution (`nav.ts`, the one conflict):** the branch predated both the `Me` group and the
  `Assistant` row; both were kept. `Me` is a rail **flyout** with a new `user` glyph, not pinned -
  pinning it alongside Workspace would put 7 flat rows above the categories and undo the rail.
- **New:** [`docs/sidebar-nav-map.md`](../sidebar-nav-map.md) - the authoritative human index of
  where every nav row sits, its capability gate, and a per-push change record. Nav moves have been
  landing as unreadable one-line array diffs; this is where they get explained. `nav.test.ts` gained
  a guard so a new group cannot silently ship without a rail glyph (it would fall back to a generic
  `box`) and so a second `pinned` group fails the suite.
- **Not verified:** the three new Playwright specs (collapse, rail flyout, cookie persistence) are
  not `@smoke`-tagged, so CI does not run them and this session did not - they need a live backend.
  `tsc`, 1340 vitest tests and `next build` are green on the merge result.
- **Inherits an open a11y item.** `0.19.1` below defers `.erp-side__grouplabel`'s raw CSS `opacity`
  (axe-excluded there, needs a reviewed `shell.css` fix). That selector now also styles the rail
  flyout's `.erp-railmenu__title`, so the deferred fix covers one more surface than when it was
  written - not a new defect, a wider blast radius for the existing one.
- Lands AFTER the `Alpha 01.026.0067a` cut, which manifests platform-ui `0.19.1` - `0.20.0` is
  unreleased until the next cut. (Numbered `0.20.0`, not `0.19.0`: concurrent sessions claimed
  `0.19.0` and `0.19.1` below while this merge was being verified.)

### [0.19.1] — 2026-08-07 · IN PROGRESS (automated a11y auditing + the manual checklist automation can't replace)
- **`@axe-core/playwright` added, devDependency only.** Runtime deps stay exactly `next`/`react`/
  `react-dom`/`server-only` — nothing from this ticket is imported by app code. New
  `e2e/a11y-axe.spec.ts`, 15 checks total (7 surfaces × light/dark): `/assistant` empty state,
  an active thread with real history, a genuinely mid-stream snapshot, a proposal card awaiting
  confirmation, both drawers (assistant + PM task, each opened the real way — a click, not a direct
  `goto` — since the task drawer only intercepts a client-side navigation), and one dense baseline
  page (the project board). All 15 green. Not wired into the CI merge gate (`--project=smoke
  --grep @smoke` doesn't touch it) — this suite is slower (real SSE round trips) and less
  deterministic on a shared, often multi-agent-loaded box than the smoke check; it stays an
  on-demand/CI-nightly audit (`npm run e2e:a11y`) until proven stable enough to gate on.
- **Two real bugs in the test's own first draft, both instructive:** (1) the shared session's
  default active company is NOT the one every seeded assistant/PM fixture lives under, so
  `/assistant?thread=…` silently rendered empty until the spec pinned `gaiada_tenant=co-agency`
  itself (same trap `smoke.spec.ts` already worked around) — a reminder that "the page rendered
  with no error" and "the page rendered the right DATA" are different claims, even inside a test.
  (2) demoAssistant's `STALL_TEST` hook never emits a `token` event by design (it exists to prove
  the 120s idle-timeout path), so `streamReducer` never flips `status` to `"streaming"` and
  `aria-live="off"` never actually turns on — a genuinely mid-stream DOM snapshot needs a real
  (short) reply, not the stall hook.
- **Fixed, because axe caught real defects that were cheap and clearly ours:**
  - `ProgressBar.tsx`'s `role="progressbar"` had no accessible name (every PM progress bar,
    board cards + the detail meta strip) — `aria-label={"Progress: N%"}` added.
  - `Contributors.tsx`/`Dependencies.tsx`'s "Add a contributor…"/"Add a blocker…" `<select>`s had
    no label at all — `aria-label` added to each.
  - Six places in `assistant.css` used `--ink-faint` (the token's own comment: "decorative
    only", ~3.3:1) on text that is actually informational — a message's token/cost line, a
    fenced-code-block language tag, the streaming status line (which IS the `aria-live` content),
    a proposal's redacted-arg field names, its expiry deadline, and the tools-mode composer hint.
    All six promoted to `--ink-subtle` (>=4.5:1), matching sibling elements on the same components
    that already used the correct tier.
- **Deferred, recorded, not silently suppressed** (exact rule id + reason lives in the spec file
  and the full report): the sidebar tagline/nav-group labels' raw CSS `opacity` (app-wide, not a
  surface this program built, needs a `shell.css` fix + visual review); the task-drawer section
  headers' `--ink-subtle` measuring 4.42:1 in dark theme against the 4.5:1 the token's own comment
  claims (a one-line token bump would fix it everywhere at once, which is exactly why it needs its
  own reviewed ticket, not a number picked blind here); PM tag chips' user-chosen swatch colours
  (a palette/design problem, not a token bug). A broader systemic finding, NOT yet verified with
  axe and NOT fixed here (scope discipline, not an oversight): `--ink-faint` is used on more
  real-information text elsewhere in `assistant.css` (Memory/Capabilities panel hints, the rail's
  empty-state message, message meta lines) that this ticket's 7 tested surfaces never render —
  worth its own pass.
- **New `docs/a11y-manual-checklist.md`** — a ~15-minute scripted NVDA/VoiceOver pass for what axe
  cannot check: whether the streaming reply announces once (not per token), where focus lands after
  Confirm/Dismiss on a proposal card (a known, unfixed gap — the buttons unmount and nothing moves
  focus), whether the proposal card's own state change is announced at all (it isn't wired to
  announce currently), and whether the collapsed thread rail is reachable/correctly announced.
  **No real screen reader has been run against it as of this entry** — every "expected" result in
  it is a prediction from reading the code, stated as such.
- Report: `docs/superpowers/plans/2026-08-07-a11y-automation-report.md`. `tsc` clean; full vitest
  suite green (1344, no regression); `DEMO_MODE=1 npm run build` green; the CI smoke check
  (`--project=smoke --grep @smoke`) still passes.

### [0.19.0] — 2026-08-07 · IN PROGRESS (the assistant brain picker offers Ollama Cloud)
- **`BRAIN_OPTIONS` gains `openai` — "Ollama Cloud".** The picker previously offered Auto / Ollama
  (local) / Hermes / Gemini / Claude, so the OpenAI-compatible cloud slot was unreachable from the UI
  even where it was configured. Now selectable.
- **The two Ollamas are DIFFERENT providers and the labels say so.** `ollama` is the LOCAL daemon
  (`OLLAMA_URL` — on-box, no egress, no cost); `openai` is the OpenAI-compatible cloud slot
  (`OPENAI_BASE_URL`), which on `gda-aicenter` points at Ollama Cloud (`https://ollama.com/v1`). Same
  vendor brand, different runtime, different cost and failure modes — a deployment that repoints
  `OPENAI_BASE_URL` elsewhere should relabel this entry.
- **A wrong `value` here fails SILENTLY, which is why it now has tests.** `value` is the GATEWAY
  PROVIDER NAME, sent verbatim as the hint: the platform stores `brainProvider` as free text with no
  allow-list, and `chain.RunWithHint` ignores a hint naming a provider that is not in the chain — so a
  typo degrades to "Auto" with no error anywhere and the badge still names whoever really served.
  Nothing else in the stack would catch it. 4 tests pin every value against a restated copy of
  `ai-gateway-go`'s `knownProviders` (restated, not imported — separate projects, not a monorepo), that
  local and cloud Ollama stay distinguishable to a human, and that `brainOptionLabel` round-trips.
- 97 tests green in `assistant.test.ts`; `tsc` clean.

### [0.18.0] - 2026-08-07 - IN PROGRESS (the chat no longer opens onto a debug panel)
- **The empty state was the raw tool registry** - `activity.feed`, `authz.check`,
  `workActivity.relink`, with developer prose - and it was the first thing anyone saw. Replaced with
  four human-readable tiles; the catalogue MOVED behind the existing CAPABILITIES button rather than
  being deleted, so power users keep it and newcomers are not confronted with it.
- Suggestions **fill the composer and never auto-send** - auto-sending would spend a real provider
  call on a guess at the user's intent.
- **Threads auto-title from their first message.** The sidebar was a column of identical "New chat"
  rows. Empty/stalled threads still read "New chat"; long text breaks on a word boundary; a pasted URL
  with no spaces truncates at the character limit instead of being chopped to nothing; a manual rename
  always wins. FE-derived was chosen over a backend LLM summary (better titles, but a model call per
  thread and a platform-nest change) - the rejected option is recorded as a decision, not an omission.
- **The rail collapses**, persisted via the existing `gaiada_prefs` cookie with a type-guarded parse,
  so a cookie written before this field existed cannot break the page. `aria-expanded` set, keyboard
  reachable in both states, and nothing added near the `role="log"` transcript that would make a
  screen reader announce more than it should.
- Verified headless in light AND dark themes. **No real screen reader was run.**

### [0.17.0] - 2026-08-06 - IN PROGRESS (ASST-23 proposal card; a real thread-load race fixed)
- **The proposal card**, full D14 lifecycle: awaiting-confirm -> sent for approval -> approved+executed
  -> failed+retry, plus rejected/dismissed/expired. This REMOVES the old "approval does not execute"
  disclaimer, which stopped being true when D14 landed. First UI path that can send `mode:'tools'`.
- **A real latent bug fixed:** `loadThread(id)` was async and nothing checked whether `id` was still
  active when it resolved - switch threads mid-fetch and the older response lands last, silently
  overwriting the new thread's messages. Guarded with a SYNCHRONOUSLY-updated ref; a `useEffect`-updated
  ref would still lag the render the guard compares against, so it would have looked right and fixed
  nothing.
- **The `approval_id`-is-null trap, resolved deliberately:** it reads null BOTH for a plain read and for
  "nothing to join yet" - different facts, identical appearance. `deriveProposalCardState` reads
  `intent` first, `approval` second, and falls back to "not a proposal" only when BOTH are null. That
  ordering IS the fix, not a style choice.
- **Confirm and Dismiss send NO args** - the card shows the redacted args the SSE gave it and never
  sends them back, because a tampered confirm could otherwise file user-authored args wearing model
  provenance.
- A committed Playwright spec (6 tests) replacing a throwaway script, and demo fixtures making
  `rejected`/`execution_failed`/`cancelled` reachable through a real confirm click. **Honest limit:** the
  spec is in the `chromium` project and CI runs `--project=smoke` - so it is coverage you can RUN, not
  a merge gate.
- Earlier in this window: four a11y defects on `/assistant` and the `TaskDrawer` Tab focus trap. Both
  drawers were modal to a screen reader and porous to the Tab key.

### [0.16.0] — 2026-08-05 · IN PROGRESS (`/me` — the personal hub, and it is not under HR)

Employee-portal waves A + F.

**Why a section and not a second shell.** Clients got their own interface because they are outsiders
with no ERP identity. An employee already IS an ERP user, so a second shell would mean two
navigations and two places for "my stuff" to live. What was missing was never a shell — it was a
HOME: the seven self-service surfaces an employee needs (`/`, `/account`, `/people/:userId`,
`/reports/person`, `/appraisals/mine`, `/timesheets`, notifications) were scattered across
Workspace / Business / Reports / Appraisals with no entry point. `/me` re-homes them as LINKS, so
each keeps its single implementation and its original nav home.

**And not under HR** (owner, 2026-08-04): HR manages employees to the extent HR needs; this section
is what the employee themselves owns. Hence top-level, first in the nav, and ungated — there is no
capability to hold, and gating it would gate someone out of their own leave, loans and inbox.

- `/me` — at-a-glance (unread / leave awaiting a decision / loan outstanding) + the eight doors.
- `/me/leave` — the employee's own leave. NO new backend surface: the `member` self-service rule
  already allowed read/create/cancel of one's own leave, and `LeaveForm`/`fileLeave`/`cancelLeave`
  already existed for the HR console. This is the same components addressed to the subject.
- `/me/loans` + `/me/loans/[loanId]` — request with a live monthly estimate, then the frozen
  schedule, the derived FIFO allocation and the money ledger. The repayment form renders only for
  `hr.manage` holders; showing it to the borrower would be a button that 403s.
- `/me/inbox` (wave F) — the honest shape of an employee inbox on this backend. There is no
  personal-mailbox store; there are per-user NOTIFICATIONS and entity-scoped MAIL THREADS. Inventing
  a mailbox would mean a second unread model to keep in sync, so a notification row is the unit and
  opening one renders a single `MailThreadPanel` (not one panel per row — that would be N BFF reads
  for a page people mostly scan). Reuses `/notifications`' server actions so "read" means one thing.

Two traps this build walked into, both from `platform-ui/CLAUDE.md` and both worth the reminder:

- `lib/loans.ts` first held types, pure helpers AND the `platformFetch` readers, while the
  `"use client"` loan forms imported `money` from it — a `server-only` import reaching a client
  component, which breaks `next build` while `tsc` and vitest stay green. Split into `loans.ts`
  (pure, client-safe) + `loans-data.ts` (`server-only`) per the module-trio convention.
- `Field` is uncontrolled (`defaultValue` only), so the live estimate reads the form on change rather
  than per-input state — it cannot drift from what will actually be submitted.

`lib/demoLoans.ts` keeps every surface drivable under `DEMO_MODE` (deliberately stateless: a frozen
schedule and an append-only ledger have no interesting in-session mutation to model). Three loans in
different states — active/part-paid with one overdue, settled with interest, pending with no schedule.

1145 UI tests + `tsc` + `DEMO_MODE=1 next build` all green; `nav.test.ts` updated for the new group.

### [0.15.3] — 2026-08-05 · IN PROGRESS (UI-01: reauth now preserves the deep-link target)

Closes the gap MAIL-09 found live (Smoke 3 / ex-Q-V7 — see `docs/modules/MODULES.md`'s mail
§0.0.15 note): an emailed approval/pipeline link clicked with no session redirected to `/login`
with no `?return=`, so a successful reauth landed on `/` instead of the entity — defeating
MAIL-05/06's correct `entityHref()` links one hop after the email tap did its job. Root cause:
`middleware.ts`'s redirect-to-login never carried a return target at all, and the OIDC/SSO entry
point (`/auth/login`) had no return-path concept whatsoever — only the dev-login path and
`/step-up` did, each with its own copy of the same shallow validator.

- **One shared validator, `lib/returnTo.ts`** (`sanitizeReturnTo`/`sanitizeReturnToParam`),
  replacing three near-identical `startsWith("/") && !startsWith("//")` copies
  (`step-up/page.tsx`, `login/page.tsx`, `login/actions.ts`). Same-origin, path-only, defaulting to
  `/`, never throws. Layered checks: literal backslash/`//`-prefix rejection, a bounded (6-round)
  percent-decode loop that catches double/triple-encoded protocol-relative and backslash payloads
  a single defensive decode would miss, then an authoritative backstop that parses the candidate
  against a sentinel origin with the real WHATWG `URL` parser and requires the result to have
  stayed on it — catches the backslash-as-slash quirk, control-character stripping, and other
  parser tricks without hand-deriving every state-machine path. Edge-safe (no `node:crypto`), so it
  runs unmodified in `middleware.ts`, server components, `"use server"` actions and Node route
  handlers.
- **`middleware.ts`** now appends the originally-requested path+search as `?return=` on its
  redirect to `/login` (omitted when the target is already `/`, so the no-return-target case is
  byte-for-byte unchanged).
- **`/auth/login` (SSO initiation)** reads and validates `?return=`, then carries it through the
  Keycloak round trip as a third base64url segment of the existing httpOnly `oidc_pkce` cookie
  (never as a URL param to the IdP) — base64url has no `.`, so the cookie's `.`-delimited shape
  stays an unambiguous 3-way split. **`/auth/callback`** decodes that segment and re-validates it
  via `sanitizeReturnTo` at the actual point of redirect, replacing the old hardcoded `"/"`.
- **`LoginForm.tsx`**: the non-SSO-only view's bottom "Sign in with SSO" link carried no `?return=`
  at all (only the SSO-only view's link did) — fixed to match.
- 30 new unit tests (`lib/returnTo.test.ts`) pin the happy path plus 20+ open-redirect probes:
  absolute URLs, protocol-relative (`//`, `///`), backslash variants (incl. the WHATWG
  backslash-as-slash quirk), single/double-encoded protocol-relative and backslash forms,
  `javascript:`/`data:`/`vbscript:` schemes (bare and `/`-prefixed), userinfo host-smuggling,
  tab/newline-injected protocol-relative, and malformed percent-encoding — all refuse and fall back
  to `/`. 5 new Playwright cases (`e2e/auth.spec.ts`, `e2e/portal.spec.ts`) walk the REAL round trip
  (middleware redirect → login → landing) for `/approvals/:id`, `/pipeline/:id`, a portal deep
  link, the no-return-target default, and 7 open-redirect probes against the running app — all
  green.
- `npx tsc --noEmit` clean; full suite green (109 files / 1145 tests); `DEMO_MODE=1 next build`
  green. **Caps at IN PROGRESS**: the live re-walk is PENDING-DEPLOY — re-run MAIL-09's ex-Q-V7 leg
  once this ships.

### [0.15.2] — 2026-08-05 · IN PROGRESS (APPR-01: per-approval detail route)

Closes a confirmed gap found during the mail build (owner-approved this session): emailed
approval links landed on the bare `/approvals` LIST — `lib/mail.ts`'s `entityHref()` mapped both
`automation_approval` and `agency_approval` to `/approvals` with no id, while `pipeline_run`
correctly got `/pipeline/:id`. Also closes MAIL-15's one deferral: `MailThreadPanel` had nowhere
to live on the approvals surface until this route existed. **Caps at IN PROGRESS** — no deploy
path right now, so the live-walk ACs are PENDING-DEPLOY.

- **New `/approvals/[id]` detail page** (`app/(app)/approvals/[id]/page.tsx`). The url carries
  only an id (matching what `payload.href`/`entityHref()` emit — no `?kind=` query param), so
  `lib/approvals.ts`'s new `getApprovalDetail()` tries the automation read first (its backend
  fetches the row BEFORE authorizing, so a 404 there is a genuine "not this kind" and safe to fall
  through) then the agency read; either leg's 403 propagates immediately as a real refusal
  (`limitedState()`, same convention as `/admin/mail/[id]`) rather than being swallowed into
  "try the other kind". Renders overview fields per origin, a decide form (routed through the
  SAME `POST /api/:t/approvals/:id/decide` façade the unified inbox already uses — hidden
  `tenantId`/`approvalId`/`origin` fields, no closure over the fetched row, mirroring
  `pipeline/[runId]`'s `GateRow`), and the `MailThreadPanel` embed MAIL-15 deferred.
- **`entityHref()` now returns the id-bearing route for staff** (`/approvals/:id`, was the bare
  `/approvals`) for both `automation_approval` and `agency_approval` — pinned in a new
  `lib/mail.test.ts`. **Portal is unchanged**: these two entity types are staff-only (their
  decider sets never resolve to a client principal), so there is no per-item portal surface to
  link to — only `pipeline_run` has one, and it was already id-bearing on both sides.
- **`decideApprovalItem` (`app/(app)/actions.ts`) gained a `revalidatePath` for the specific item**
  alongside its existing `/approvals`/`/` — a no-op for the older callers that never visit it.
- **DEMO_MODE**: an explicit fixture for the new automation-approvals detail route
  (`demoFixtures.ts`) plus a defensive `isRowShaped()` guard in `lib/approvals.ts` — the file's
  final GET catch-all returns an empty ARRAY (`ok([])`), which is truthy in JS, so an unguarded
  demo id with no fixture would render a confident wrong page instead of falling through to the
  other backend/404 (the exact "frontend-first drift" trap this project's `CLAUDE.md` warns
  about; caught by a live DEMO_MODE Playwright smoke while building this, not by `tsc`/vitest).



The client portal as a **separate interface** from the employee ERP (owner decision, 2026-08-04). The
separation that was missing was presentational — the backend split was already clean — so this is a new
route group with its own shell, navigation, vocabulary and empty states, sharing the design system and
none of the staff layout.

- **`(portal)` route group, 11 routes.** Overview · Projects (+detail) · Timeline · Deliverables ·
  Approvals (+run detail) · Invoices (+detail) · Agreements (+detail) · Profile. `(app)/portal/*` was
  **deleted** — two route groups cannot both serve `/portal` — and the old `/portal/[runId]` moved to
  `/portal/approvals/[runId]`, which also removes a dynamic segment that sat one static sibling away
  from swallowing `/portal/invoices`.

- **Route group, not a second Next app.** It is genuinely a separate interface; what it does not
  duplicate is the plumbing (HMAC session, the single server-side egress, tokens, DEMO_MODE, the
  Playwright harness, the CI build gate). Splitting it out later is moving one folder; unpicking a
  divergent copy of the session layer would not be.

- **Own chrome** (`components/portal/`): sticky header + horizontal tab strip, a live-state indicator,
  and a two-item account menu. Deliberately absent: the company switcher (a client belongs to the one
  company that serves them), global search over internal entities, the approvals inbox, the departments
  rail, and the density/width preferences. All colours come from the token layer — `portal.css` contains
  no literal, so `styles/tokens.test.ts` still governs it.

- **`PortalLive`** — EventSource against a new `/api/portal/stream` route handler (one of the enumerated
  exceptions to "pages call `platformFetch` directly": EventSource is a browser API and the token never
  leaves the server). It renders no stream data — a frame triggers `router.refresh()`. **Polling is
  always armed** (120s live / 30s otherwise) rather than switched on after a detected failure, because
  SSE fails invisibly from the client: a buffering proxy, a network that kills long-lived connections, a
  backend with no Redis. Also refreshes on tab focus.

- **`lib/portal.ts` split into the documented trio** (`portal.ts` pure + `portal-data.ts` server-only +
  `portalActions.ts`). It used to BE the reader module; a `"use client"` live component importing
  `PortalTopic` from it would have pulled `server-only` into the browser bundle — the exact trap where
  `tsc` and vitest pass and `next build` breaks.

- **Money and dates are locale-pinned** (`money`, `portalDate`, `relativeDays`, `isPastDue`). Bare
  `toLocaleString` reads the host's ICU data, so server render and client hydration disagree; on a due
  date that is the difference between "today" and "overdue", and on an invoice it is a client's total.

- **Write flows use `useActionState`, not void form actions.** The server refuses these for reasons a
  client can act on ("your access is view-only", "amount exceeds the outstanding balance", "this
  agreement's term has ended"). A void action swallows all of them and re-renders unchanged, which reads
  as "the button is broken" on the two most consequential things a client does here.

- **The payment form never says "paid".** It records a claim that finance verifies, and the copy says
  so — a client who believes the portal has settled their invoice will not answer the reminder that
  follows. The contract page puts the terms ABOVE the signature block, always: a sign button on a page
  that does not show what is being signed is not a signature, and the form does not render at all when
  no document is attached.

- **A real bug the tests caught, fixed in the backend too:** re-signing a contract returned **400 "this
  agreement is signed and cannot be signed"** to the person who had just successfully signed it, because
  the status check ran before the already-signed check — and signing is what changes the status. A
  double-tapped button on a phone hit it. Both the controller and the fixture now check idempotency
  first.

- **`demoPortal.ts`** — a stateful demo store carrying the states that make branches reachable in a
  browser: an overdue open milestone, a contract awaiting the client with our side already signed, a
  partially-paid invoice. It mirrors the real BFF's *behaviour*, not just its shapes — the identity 403
  and the payment claim/confirm split are asserted, because DEMO_MODE is what the build gate and
  Playwright run against, and a fixture more permissive than the backend makes every downstream check
  pass against a backend that does not exist.

**Verification (local):** `tsc --noEmit` clean · `DEMO_MODE=1 npm run build` green with all 11 portal
routes emitted · `npm test` **1040/1040** across 102 files (43 new: 25 pure-helper, 18 fixture-fidelity)
· `playwright --project=portal` **6/6** — the shell swap (staff surfaces asserted ABSENT), all 8 tabs,
contract signing, payment recording, and the staff teach-state.

### [0.12.0] — 2026-08-04 · PROTOTYPED (design-system pass from `reva/ui`, plus the queue fix)
Authored on `reva/ui` across 15 commits and consolidated in merge `04459ef`; that branch never
versioned its own work, and the cut it landed in (`Alpha 01.010.0029a`) was made by a concurrent
session for a different change, so this entry is written after the fact. Full context in that release
entry. The concurrent session's own portal fix also lands under this same version.

- **Token layer** (`styles/tokens/`, 5 files). The chart palette moves out of component CSS into
  tokens — light, both dark blocks, and the print override side by side — so the existing parity test
  now covers chart colours too. 5 hard-coded colours fixed, including `--erp-ink-40`, which was
  defined nowhere in the codebase and had been silently rendering its `#999` fallback with no
  dark-mode value.
- **`/calendar` rewritten** — personal focus, real month/week/day grids, and an explicit "N of yours
  have no date — not shown here" instead of quietly dropping undated items. This deletes the workload
  panel `0.10.3` had just repaired; the rewrite serves that fix's purpose better.
- **PM** — tasks open in a slide-over, the project workspace leads with the work, and the Gantt no
  longer re-renders itself to death when handed no `groups` prop.
- **`fix(queue)`: My Work was blind to every PM task.** The queue read the core `tasks` table while
  the app writes `pm_tasks`, and never loaded `lib/pm`'s `statusFlags`, so it could not tell done from
  open either. Structurally empty while looking healthy — the same class as `0015b`'s
  knowledge-indexing miss.
- Dashboard hierarchy with real tasks · state-legible form inputs · loading feedback where Next
  showed none · empty states unboxed ("a sentence, not a boxed panel") · page header cut to one line ·
  KPI tiles explain the rule their label hides · Settings → About reporting the deployed version ·
  a component guide for the project.

Verified on the merge result: `tsc` clean, `next build` green, 974 tests pass (945 before — 29 new).

> `0.10.4` and `0.11.0` have no entries — see the ledger-gaps note in `Alpha 01.010.0029a`.

### [0.10.3] — 2026-08-03 · PROTOTYPED (six surfaces that reported a state they were not in)
Found by driving the live site as a signed-in user across all 84 routes under both companies. None of
these threw; each one asserted something false, which is why they had survived.

- **Roles picker** — passes the active tenant to `listRoles` so the catalog stops listing every
  company's identically-named roles.
- **HR scope** — the selector called every company "served" because an elevated caller was folded in
  as a `home` grant, while the envelope directly beneath reported those same companies "not served".
  Adds an explicit `elevated` reason, renames the option to "All companies in scope", and widens the
  404 label to "HR not enabled or not served" (the backend returns 404 for both).
- **Tasks** — the default all-companies leg is assignee-scoped, so a task you had just created
  unassigned looked like it was never saved. The empty state now says the view shows only your own
  tasks and links each company's "All tasks" view.
- **Calendar workload** — refused to render without a narrowed scope, while all-companies IS the
  default: dead for every visitor. A per-person split is meaningless there (the union is the caller's
  own tasks), so it breaks the same rows down by company.
- **Hydration** — React #418 on `/systems/gateway`, `/hub`, `/automation`. Bare `toLocaleString()`
  formats in the container's zone server-side and the visitor's client-side, so the text differed and
  React threw away the server HTML for that subtree. Adds `formatTimestamp()` on a fixed display zone
  (`NEXT_PUBLIC_DISPLAY_TZ`, default `Asia/Singapore`, inlined at build so both sides agree) and moves
  those call sites onto it; `formatDate`/`formatDateTime` pinned to the same zone.
- **Client portal** — the BFF 403s "not a portal client" for any staff member, which the reader folded
  into an empty list, so staff were told "once your kickoff is processed, your project appears here"
  as though a project were on its way to them. The reader carries that distinction now.

Verified: `tsc --noEmit` clean, `next build` green, 945 tests pass.

### [0.10.2] — 2026-08-03 · PROTOTYPED (a disabled module now says so)

Closes the mismatch `0.10.1` left open: nothing outside the settings page read `enabled_modules`, so
a disabled module's pages stayed clickable and merely came back empty — **identical to a company
that genuinely has no clients, no devices, no invoices**.

- `lib/modules.ts` — `moduleGate()` / `isModuleOnForActiveCompany()` over
  `GET /api/:t/modules-enabled`. **Fail-open on purpose:** a module reads as disabled ONLY when the
  backend positively said so. Missing endpoint, error, odd payload shape, no active company → every
  module passes, because a false "disabled" panel hides a working page, which is worse than the
  empty-page problem being fixed. The shape check is deliberate (`Array.isArray`) rather than
  `?? []` — coercing a generic empty-list response to "no modules" would dark every gated section.
- `ModuleDisabled` panel + section layouts for `/agency`, `/clients`, `/billing`, `/hr`, `/it`,
  `/knowledge`, `/reports`, `/appraisals`. It states that nothing was deleted and links to
  Settings → Modules & Fields with the module key.
- **The nav is deliberately NOT filtered.** Hiding the entry would repeat `0.10.1`'s bug in the other
  direction — the surface disappears with no trace of why or how to get it back. The section is
  reachable and explains itself.
- **Gated only where the module actually owns the endpoints**, each verified against the controller's
  guards. Explicitly NOT gated: `/projects` + `/tasks` (core `CoreController`, unguarded — the `pm`
  module owns `/api/:t/pm/*`, so honouring its `uiManifest` claim of `/projects` would have hidden two
  working pages from every company, none of which currently has `pm` on); `/systems/automation`
  (`automation-console` is a documented non-per-tenant deviation — global admin console, no
  `:tenantId` to gate on); `/deliverables` + `/timesheets` (core `client-work.controller`); `/search`
  (global search, unrelated to the `search` module).
- DEMO_MODE reports the full compiled-in set, so the backend-free tour is unchanged — without a
  fixture the generic empty-list default would have darked half the app.

Verified: **945 unit tests pass** (6 new for the gate's fail-open branches), `tsc` clean,
`next build` green (66 pages). **Not driven in a browser** — the Playwright suite needs a local
server on :3005, which standing policy says not to run here.

### [0.10.1] — 2026-08-03 · PROTOTYPED (the module toggle was one-way)

Pairs with platform-nest `0.9.1`. Reported as "I disabled a module to see the difference and now it's
gone" — accurate. **Settings → Modules & Fields could turn a module off and never back on.**

- The toggle list was `union(["agency"], company.enabled_modules)`. Disabling a module removes its key
  from that array, so the row it was rendered from **disappeared with it** — every module except the
  one hardcoded key was a one-way switch recoverable only by direct API/SQL write. The list now comes
  from `GET /api/module-catalog` (all ten compiled-in modules), still unioned with `enabledModules` so
  an enabled-but-no-longer-compiled key stays visible and removable. Falls back to a static list of
  the ten keys on 404, so it works against a backend without the endpoint.
- Each row now shows the module's real label and the nav paths it owns — disabling a module 404s those
  routes via `ModuleEnabledGuard`, and the row previously said nothing about what would go dark.
- **The company edit form was silently stripping modules.** `CompanyForm` knew only about `agency` and
  its update action sent the derived set as `modules`, replacing `enabled_modules` — so editing a
  company's *name* dropped `hr`/`reports`/etc. The field is now create-only; on edit the form shows the
  current set read-only and `updateCompanyAction` omits `modules` entirely, leaving the backend's
  `COALESCE($5, enabled_modules)` to preserve it.

Live consequence of the old behaviour, found on `gda-aicenter`: Gaia Digital Agency held `{agency}`
though the seed grants `{agency, hr, reports}`. `hr` was restored by direct SQL; **`reports` is still
off**. The nav is gated by RBAC and never reads `enabled_modules`, so a disabled module's pages stay
clickable and merely return empty — that mismatch is NOT fixed here.

Verified: 939 unit tests pass, `tsc` clean, `next build` green. Not driven in a browser; the running
image predates both changes.

### [0.10.0] — 2026-08-03 · PROTOTYPED (real IT topology + device edit/remove)

Pairs with platform-nest `0.8.0`.

- **Topology** now draws the real graph — gateway → access point/switch → device — from the resolved
  edge set, replacing a `buildTopology()` that could only regroup rows by two free-text strings and
  had no way to express an uplink. Falls back to the old site→network grouping while no edges exist,
  so today's view is unchanged until a collector reports.
- A **sync banner** states the feed's age, host count and BYOD aggregate, and says plainly when
  nothing has ever reported. Without it an operator reads silence as "all clear".
- Devices with no resolved uplink get their own bucket rather than being omitted — hand-registered
  devices never report one, so hiding them would make the map disagree with the device list.
- **Device edit + remove** (neither existed). On a discovered row the collector-owned facts
  (`ip`/`mac`/`hostname`/`status`) are hidden because the API rejects them; descriptive fields are
  kept in an overrides layer and survive the next sync.
- Devices tab gains search (name/hostname/IP/MAC), a class filter, a discovered-vs-manual badge, and a
  50-row cap with "Show all" — the table was unusable at a real estate's ~58 rows.

New `Device` fields are all optional, so the UI still renders against a backend without `0071`.
Verified: 939 unit tests pass, `tsc` clean, `next build` green. Not driven in a browser.

### [0.6.5] — 2026-07-27 · PROTOTYPED (console write controls)
- **Gateway config is editable** where the gateway says it is: new `OverridableConfigField` renders a
  save per writable key AND the one fact a plain form can't express — whether the value is a console
  override shadowing the env — with a **Revert to env** action. Without that, an operator who fixed
  the env and redeployed would see the old value and conclude the deploy failed. Read-only keys
  (credentials, egress allowlist, TLS mode, topology) stay in the description list, and the card shows
  a "read-only" badge when the running gateway exposes no write route at all.
- **Workflow activate/deactivate** in the Automation workflows table (elevated only), driven off the
  ID-bearing `/automation/workflows` list rather than the status probe's name-only rows — which never
  carried an id. Deactivation is confirm-gated because it stops real automation. When the ID list is
  unavailable (no n8n API key) the table still renders from the probe rows and says why the controls
  are missing.
- **Dead-letter replay** per bridge stream, offered only where something is actually parked, with a
  confirm naming the count.
- **NEW** `components/systems/ActionButton.tsx` (single-lever server action + pending/result feedback
  + optional confirm), `OverridableConfigField.tsx`; `lib/admin.ts` gained `setGatewayConfig`,
  `revertGatewayConfig`, `setWorkflowActive`, `replayBridgeStream` over a shared `writeCall` helper
  that surfaces the service's own 4xx message verbatim and maps 404/405 to "not available".
- 462 unit tests green (+7); `tsc` clean; `next build` green. Demo fixtures cover every new write.

### [0.6.4] — 2026-07-27 · PROTOTYPED (Gateway / MCP Hub / Automation consoles rebuilt with real content)
- The three pages were rendering everything the contract gave them; the contract was the problem
  (see platform-nest 0.6.2). With the backend widened, all three were rebuilt around what an operator
  actually acts on.
- **AI Gateway** — budget first (calls today vs effective cap, **per-tenant spend table**), a DR-burst
  card that states the consequence and separates declare/resolve instead of being an ambiguous toggle,
  one `ChainTable` per capability showing failover ORDER + breaker state with a plain-language reason
  per provider (and calling out providers configured in the env but never built by the gateway), a
  provider inventory with credential presence only, a DLP/egress-posture card, and an egress audit
  that is filterable by decision (incl. specific block reasons) and capability. Filters are `<Link>`s,
  so the page stays a server component and a filtered view is shareable.
- **MCP Hub** — policy card leading with **which engine decided** (Cerbos vs in-code fallback), limits
  & transport, tool registry with source attribution + filter, the **decision audit** (previously
  unreadable), the per-workflow automation scope matrix, and the **Resources + Prompts** primitives
  the page had never shown.
- **Automation** — at-a-glance strip, workflows, **execution history**, **event-bridge health** with a
  dead-letter warning band, and the **suspended-writes approval queue** (tenant-scoped, and labeled as
  such). Links to the existing read-only n8n canvas rather than duplicating it.
- **NEW** `components/systems/ChainTable.tsx` (+5 tests), `components/systems/DrModeCard.tsx`;
  `lib/admin.ts` gained the detail/audit/executions/bridge readers, a filterable `getEgressAudit`, and
  `setDrMode` (+11 tests). Demo fixtures extended so all of it is browsable with `DEMO_MODE=1`.
- 455 unit tests green; `tsc` clean; `next build` green.

### [0.6.3] — 2026-07-27 · PROTOTYPED (bot page correctness)
- **Data loss — `optIn` dropped on save:** `BotGroupConfig` had no `optIn`, and the bot's `PUT /admin/groups`
  is a FULL REPLACE that normalizes `optIn: Boolean(g.optIn)`. Any save from the ERP therefore turned
  per-group digest post-back OFF for every group. Added the "Digest back" checkbox column; `optIn` now
  round-trips (covered by the payload-shape test).
- **Unwarned mode switch:** the registry is a mode switch, not a list — while it is empty the bot ingests
  every group it sees; the first saved entry makes it ingest ONLY listed groups. The Groups tab now warns
  before that first save and names how many discovered groups would be dropped.
- **Stuck "Loading…":** a failed fetch leaves the state null, so the Chats thread and both Logs panels
  claimed to be loading forever while only a small toast showed the error. They now render an explicit
  "couldn't be loaded" state.

### [0.6.2] — 2026-07-27 · PROTOTYPED (bot Logs empty state)
- **Action audit:** the empty state said only "No audited actions yet.", which reads as a broken panel. It
  now states what populates it (member add/remove, admin promote, group rename — including denied and
  step-up attempts) and what doesn't (ordinary messages, digests). No behavior change; the audit was
  correctly empty.

### [0.6.1] — 2026-07-27 · PROTOTYPED (discovered-group rows)
- `GroupRegistry` renders the JID when a discovered group's subject is unresolved (was a blank row next to
  an Add button), and Add seeds the registry row with the JID rather than an empty name. See wa-chat-bot
  `0.8.1` for the bot-side cause.

### [0.6.0] — 2026-07-24 · PROTOTYPED (Connect-WhatsApp + Group Registry + agents-live surfaces)
- **Workstream A WhatsApp self-service UI (design §2.5, not yet deployed):** PROTOTYPED `src/components/systems/WhatsAppConnect.tsx` (client-side).
  Status pill (status + engine + paired number when WORKING), buttons Connect/Show-QR/Restart/Stop/Logout (confirm on logout). QR `<img>` from data URL.
  Poll status+qr every 3s while panel open and status ∈ {STARTING, SCAN_QR_CODE}; stop on WORKING (success) or FAILED (error + hint). Show `lastEvent` (reconnect/ban trail).
  Mutations = server actions in `systems/bot/actions.ts`; poll read via route handler `src/app/api/admin/bot/session/route.ts` (GET, no-store, server-side platformFetch).
- **Group Registry UI:** PROTOTYPED `src/components/systems/GroupRegistry.tsx` (client-side). Monitored-groups table (name/category/optIn/remove), discovered list
  with one-click add, management-group radio, single Save → PUT groups. Server action `updateBotGroups`. `updateBotConfig` action kept (degrades if backend 404).
  StatusCard now renders `detail.session` as a badge.
- **Workstream B agents-live surfaces (design §3.4):** agents UI extended with trigger card (goal textarea + agent select from status probe's `agents` list, elevated-only).
  Goals table now links to detail; status card consumes real `/health` probe. NEW `/agents/goals/[goalId]` page: status/budget/fan-out header, blackboard entries
  (specialist/task/status), run summaries linking to transcripts, `approval_id` deep-link to approvals inbox when suspended. NEW `/agents/runs/[runId]` or expandable
  detail panel: step list as text chips (model/tool kind + detail only, never HTML/markdown, never raw JSON). Poll every 4s while goal queued|running, stop otherwise.
- **NOT deployed yet:** UI-through path PROTOTYPED; backend for `/systems/bot` and `/agents` surfaces now answering (but not yet deployed container).

### [0.5.0] — 2026-07-23 · PROTOTYPED
- Baseline. ERP UI Plans 1–5 + People 360 + org builder + dept consoles + PM/AI-tracker + IT console;
  OIDC PKCE; `DEMO_MODE`; Playwright e2e.
- **Unreleased / next:** deploy once backend admin API is live.

## ai-gateway-go
### [0.13.2] — 2026-08-07 · PROTOTYPED (the non-streaming /complete honours the provider hint too)
- **Only `/complete/stream` honoured `provider`; `/complete` silently discarded it** and used plain chain
  order. The asymmetry looked cosmetic and was not: `ai-agents`' runner calls `/complete`, and D13's
  provider gate (ai-agents 0.7.0) enforces against the provider that ACTUALLY SERVED — so the runner
  could declare *and ask for* its eval-cleared provider and never receive it, leaving agent writes
  correctly contained but **permanently inert**. The assistant's brain picker worked only because it
  happens to stream.
- Found by probing the live box, not by reading: `hint=openai` on `/complete` returned `hermes` while the
  same hint on `/complete/stream` returned `openai`.
- Semantics unchanged and deliberately so — `RunWithHint` is a PURE REORDERING of the chain snapshot,
  never a requirement: an unknown name, or one whose provider is unavailable/breaker-open, falls through
  to normal failover. Absent or empty `provider` is byte-for-byte the old behaviour, pinned by two of the
  three new tests.
- The tests use `adminwrite_test.go`'s plain `namedProvider`, not `namedStreamingProvider` — the latter
  deliberately errors on `Complete()` to prove the stream path, a useful guard that also makes it
  unusable here.

### [0.13.1] — 2026-08-06 · PROTOTYPED (the `hermes` provider had never once succeeded — it sent no bearer)
- **`HermesProvider` sent NO `Authorization` header**, on either `/complete` or `/complete/stream`.
  hermes-gateway authenticates BEFORE it routes, so every call 401'd: the `hermes` provider has been
  non-functional since it landed. Verified against the live box before fixing — an unauthenticated POST
  to the shim returns `401`, and the shim's `GATEWAY_TOKEN` is byte-identical to this gateway's.
- **Why nobody noticed, which is the interesting part.** A site-topology chain is
  `[hermes, central-forward, echo]` (`main.go:53` strips gemini/claude/openai; `:60` appends
  central-forward). On `gda-aicenter`, `GATEWAY_CENTRAL_URL` points at that *same* hermes-gateway — so
  hermes 401'd, central-forward answered, and **Hermes replied every time anyway**. The only symptoms
  were a "served by" badge that never named Hermes and an assistant brain picker that looked inert for
  EVERY option (a hint can only reorder providers in the chain; it cannot rescue one that 401s).
- Adds `HermesToken` (`HERMES_TOKEN`, falling back to `GATEWAY_TOKEN` via the same nested-`envOr` idiom
  `DLPClassifierModel` uses — hermes-gateway's own env file defines exactly that one key). Empty is
  still allowed and still honest: the 401 then surfaces as `hermes 401` rather than being masked.
- **This changes which PROVIDER serves, not which BRAIN serves.** Unhinted callers (wa-chat-bot,
  knowledge, search) reached Hermes via central-forward before and reach Hermes via the native provider
  now — same brain, one fewer wasted 401 round-trip. So it needed no topology decision.
- Two regression tests: the bearer is asserted on BOTH endpoints against a shim that authenticates
  before routing, and the pre-fix case (tokenless vs auth-requiring shim) must fail with a `401` in the
  message so the failover reason stays legible. Full suite green under WSL.

### [0.13.0] — 2026-07-27 · PROTOTYPED (runtime config writes + a real chain lock)
- **NEW bearer-gated `PUT /admin/config`** (one key per call) **+ `DELETE /admin/config?key=`**
  (revert to env). Writable: the two budget caps, breaker threshold/cooldown, provider timeout, the
  DLP-classifier toggle, and each capability's chain ORDER. Every write is validated + bounds-checked,
  applied to the LIVE objects, and persisted — in that order, so a persist failure is reported rather
  than leaving the running state ahead of the file.
- **NOT writable, deliberately:** provider credentials, egress allowlist, TLS mode, topology. Those
  either can't take effect at runtime (credentials are captured in provider objects at boot) or would
  let a console session widen the gateway's own security boundary. `GET /admin/config` advertises
  `writableKeys` so the console renders exactly what it can change — and nothing more.
- **NEW `internal/adminconfig`** — the override store: pointer-per-key `Overrides` (nil = use env),
  an explicit `WritableKeys` allowlist, numeric sanity bounds, chain validation against the known
  provider set (an unknown name would otherwise silently SHORTEN the chain, since `buildProviderList`
  skips names it can't resolve), and an atomic temp+rename persist. `Apply()` folds overrides onto the
  env in `main` BEFORE anything is built, so a persisted override is in force from the first request.
- **Chain is now properly locked.** `Chain` had no mutex while `Run` mutated its `breakers` map from
  every concurrent request — a pre-existing latent data race that runtime reordering would have made
  much worse. Added `sync.Mutex` over all mutable state, with `Run` snapshotting the provider list so
  the lock is never held across a provider call. `SetProviders` keeps breaker state for retained
  providers (reordering is not a reason to forget a provider is rate-limited) and drops it for removed
  ones. New concurrency test drives Run + SetProviders + Report together.
- **The DLP-classifier toggle is now real:** `main` always constructs the classifier (building it
  makes no calls) and a runtime flag decides whether it RUNS. Previously a nil classifier meant the
  toggle could never be switched on without a restart; enabling it in a process that has none is a
  409 with an actionable message rather than a silent no-op.
- `GET /admin/config` reports the LIVE chain order plus `envOrder`, and the live classifier state --
  an override must never be mistakable for the env value.
- 13 new server tests (auth, allowlist refusal, bounds/type validation, live+persisted application,
  lowered-cap-degrades-immediately, reorder echo/rejection/breaker-preservation, revert, 409, and
  writes-absent-when-unwired). `go vet` + full `go test ./...` green.

### [0.12.0] — 2026-07-27 · PROTOTYPED (admin config surface: chain order, breaker internals, per-tenant budget)
- **NEW bearer-gated `GET /admin/config`** — the operational state the ERP console needs and could
  not previously see: per-capability chain **in failover order**, provider inventory, budget
  breakdown, reliability tuning, and security/topology posture. Provider credentials are NEVER
  returned — only `keyConfigured` presence (the gateway is the only component holding provider keys).
- **NEW `chain.Report()` / `chain.Settings()`** — `State()` returns a map, which loses the failover
  order that is the entire contract of a chain. `Report()` reports position + state + breaker
  internals (`consecutiveFails`, `rateLimited`, `openUntil`) so a console can explain WHY a provider
  is being skipped, and distinguish a rate-limit breaker (wait it out) from a failure breaker (fix it).
- **NEW `budget.Breakdown()`** — the same numbers `State()` reports plus the **per-tenant spend map**
  and the DR-burst window, so "who is burning the cap" is answerable. Stale-day counters still read
  as zero rather than being misattributed to today.
- 2 new server tests (auth gate + no-secret-leak + ordered chain; per-tenant attribution). `go vet`,
  `go build`, full `go test ./...` green on go1.26.5.

### [0.11.0] — 2026-07-24 · PROTOTYPED (provider timeout + 429/RateLimitError breaker + error taxonomy)
- **Provider timeouts (§3.5 Workstream B reliability):** NEW `PROVIDER_TIMEOUT_MS` env (default 60000). Every capability handler (Complete/Media/Embed) wraps
  provider calls with `context.WithTimeout(r.Context(), timeout)` — hung provider → clean failover + client disconnect cancels upstream (no hanging goroutines).
  Stream path (`/complete/stream`) handled separately (keeps its own flush loop, retains timeout safety).
- **429 taxonomy & breaker:** providers return typed `providers.RateLimitError{RetryAfter}` on HTTP 429. Chain.Run() parses Retry-After seconds, caps at 5m,
  opens provider's circuit breaker immediately for min(RetryAfter, cap) — one 429 stops hammering for exactly the advertised window without poisoning the
  "dying provider" consecutive-fail signal. No more treating 429 as a generic failure on the failover path.
- **Error taxonomy in audit + 502 body:** attempted-provider errors tagged `timeout|rate_limit|provider_error` in egress audit + 502 response (ERP console can
  distinguish causes). `Blocked: "rate_limit"` when all providers in chain are rate-limited (not a generic error). Audit trail now surfaceable for SLA/alerting.
- **Per-tenant call cap:** already EXISTS (`budget.perTenantCap` via x-tenant-id header) — runner NOW sends `x-tenant-id` on `/complete` calls (1-line change in
  gateway init) so agent load is tenant-attributed for daily cap enforcement.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session).

### [0.10.0] — 2026-07-24 · DEV-VERIFIED (openai provider path, full stack)
- New `openai` provider (`internal/providers/openai.go`): OpenAI-compatible `/v1/chat/completions`
  with Bearer auth, fronting any compatible endpoint (Ollama Cloud, OpenRouter, vLLM …). Registered in
  the chain, excluded in `site` topology like other cloud-key providers.
- **Vision media:** `Media()` handles `image/*` via a configurable vision model (`OPENAI_VISION_MODEL`,
  default `qwen3.5:397b`) using the OpenAI `image_url` content part; audio/PDF/video decline → fail over
  to whisper/gemini. Embeddings decline (Ollama Cloud has no `/v1/embeddings`).
- Config: `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` (default `deepseek-v4-flash`) /
  `OPENAI_VISION_MODEL` / `OPENAI_MAX_TOKENS`. Compose `LLM_CHAIN` defaults `openai,ollama,gemini,claude`,
  `MEDIA_CHAIN` defaults `openai,whisper,gemini`; `ollama.com` added to `EGRESS_ALLOWLIST`. 11 provider
  tests; `go vet` + full suite green.
- **e2e (full local stack):** rebuilt+restarted `gaiada-ai-gateway-1`; verified from inside the running
  containers — bot→`ai-gateway:3002`/complete and mcp-hub→gateway both returned `{"provider":"openai",…}`;
  gateway egress-audit shows every LLM call `provider:openai, ok:true`. `/health` reports `openai:ok` on
  both llm + media chains.
- **Trial:** shared Ollama Cloud key wired into dev `.env` as the stack brain (bot, MCP `llm.*`, n8n, WS8
  agents inherit it). Shared + weekly-rate-limited — dev/test only, not a prod dependency.
  **Capability:** NO image/video *generation* (that's the GPU render-gateway's job) and NO embeddings on
  Ollama Cloud; image *understanding* works (qwen3.5). `glm-5.2`/`kimi-k2.7-code` are reasoning models
  that reply empty unless `OPENAI_MAX_TOKENS` is large — `deepseek-v4-flash` returns clean content.
- **Not yet live:** WhatsApp transport (WAHA up but no paired session — needs a QR scan).

### [0.9.0] — 2026-07-23 · PROTOTYPED
- Baseline. THE gateway (`:3002`), provider chain + failover + DLP + cost cap + egress audit + mTLS +
  site/central + DR-burst. go build/vet/test green.
- **Known risk:** docker build unverified. **Next:** verify container build, OpenBao creds, media DLP.

## mcp-hub
### [0.11.0] - 2026-08-20 - PROTOTYPED (🔴 the D14 impact gate never fired for an agent)
- 🔴 **A LIVE AUTHORIZATION HOLE, and it made yesterday's release notes false.** `isAutomation(provider)`
  is literally `provider === "n8n"`, and the medium/high impact-suspend branch sat INSIDE it. But
  `runAgent` sends the requesting HUMAN's OBO envelope verbatim — deliberately, so an agent can never act
  with more authority than the person it serves — so an agent-driven call arrived as
  `provider: "whatsapp"`, the check was false, and the branch was skipped entirely.
  **An n8n workflow calling a HIGH-impact write suspended for approval; an agent calling the same tool
  ran it unattended.** `Alpha 01.056.0111a` shipped `iam.grantRole` (high) claiming all four direct IAM
  writes suspend for a human. True for n8n, false for an agent. Corrected in PERMISSION-CONTRACT §15.
- **Fixed by SPLITTING two conjuncts that were never the same question.** Workflow scope stays keyed on
  `isAutomation` — a `wf:*` allow-list lookup is an n8n concept, and applying it to agents would deny
  every agent read for a reason that was never about them. The impact gate moves to a new
  `isUnattended` = n8n OR agent-driven: attendance, not identity. A human on an interactive surface is
  attended by definition and does not approve their own click.
- **Fixed in BOTH engines.** The hub now sends `isUnattended` and `agent` as Cerbos principal attributes,
  and `resource_mcp_tool.yaml`'s impact conjunct is re-keyed. Fixing only the in-code fallback would have
  left the live deployment open, because Cerbos is authoritative whenever `CERBOS_URL` is set — the hole
  actually lived in the policy file.
- **`Principal.agent`** carries the co-author, minted from `x-obo-agent`. Omitted (not `undefined`) when
  absent, so a non-agent principal is byte-identical to before — every rate-limit key and audit ref keeps
  its shape. An anonymous principal KEEPS the marker: an unauthenticated agent-driven call is still
  agent-driven, and that is the shape that deserves the gate most.
- **`src/obo-headers.ts` is now the ONE place the outbound envelope is built**, replacing 14 hand-built
  header objects across 8 files. Adding a header to 14 sites guarantees the 15th omits it and silently
  drops attribution for whichever tool group comes next — a bug that looks like "that one tool's audit
  rows don't name the agent" and is noticed only when someone needs it. One site was typed structurally
  as `{provider, externalId}` and would have dropped the field regardless of the header, so the type was
  widened to `OboSubject`.
- Gates: `agent-impact-gate.test.ts` 17/17 (new), **verified red-then-green** — reverting `isUnattended`
  to the old predicate fails 5 cases including "an agent calling a HIGH-impact write SUSPENDS"; full hub
  suite 268/268; `cerbos compile` clean.
### [0.10.3] - 2026-08-20 - PROTOTYPED (the tool-def type was narrower than the transport)
- **`RemoteToolDef.method` gained `DELETE`**, mirroring platform-nest's `McpToolDef.method`, for
  `iam.revokeRoleGrant`. No behavioural change: `callPlatform` already read `def.method` and handed it to
  `fetch`, so DELETE always worked on the wire. A def arriving over HTTP is `JSON.parse`d, so the narrow
  union never rejected anything at runtime — it simply described the transport incorrectly, which is the
  kind of inaccuracy that survives until somebody trusts it.
### [0.10.2] - 2026-08-19 - PROTOTYPED (Cerbos was silently not authoritative for the tool list)
- 🔴 **A LIVE DEFECT, found by reading cerbos's own logs on the box — not by a test and not by an
  alert.** Cerbos rejects a `CheckResources` request carrying more resources than its configured batch
  limit (50, the default this deployment runs). The hub asks about EVERY tool in one request for the
  visibility check, so once the tool count passed 50 every check failed with
  `InvalidArgument: number of resources in batch (128) exceeds configured limit (50)` and
  `visibleToolsFor` caught it and fell back to the in-code engine.
- **What that did and did not mean.** NOT fail-open: the in-code engine is deny-by-default and mirrors
  the assurance and automation-scope rules, so no caller saw a tool it should not have. But Cerbos had
  stopped being AUTHORITATIVE for the tool list, which is the one thing `resource_mcp_tool.yaml` exists
  to be — any listing rule expressible only in the policy was simply not applied. It hid because the
  fallback logs one warning and returns a plausible answer.
- **The per-CALL path was never affected** and that distinction is asserted, not assumed:
  `cerbosAllowsTool` batches exactly one resource. So D14-13's executable allow-list — including the
  JML names added in `platform-nest 0.27.0` — has governed real calls throughout.
- **Fixed by chunking client-side** at `CERBOS_RESOURCE_BATCH_MAX = 40` (headroom below 50), chunks
  evaluated concurrently, verdicts merged, and any one chunk's failure rejecting the whole call. A
  partial allow-set is indistinguishable from "Cerbos denied those tools" — exactly the ambiguity that
  let this hide — so the fail-closed contract is preserved. Chunking rather than raising the server
  limit: the limit is a defence against unbounded requests, and the hub's tool count only grows.
- **4 new cases** whose stub REFUSES an oversized batch the way the server does, so they fail against
  the pre-fix client rather than asserting an internal detail. Verified red-then-green by raising the
  constant to 1000 and re-running (3 failed), then restoring it (29/29).
- BOOKKEEPING GAP, flagged rather than backfilled silently: MODULES.md recorded `0.10.1` but this changelog has no `[0.10.1]` entry, and rule 1 requires both. Whatever shipped as 0.10.1 is undocumented here. This entry is numbered 0.10.2 so MODULES.md stays continuous.
### [0.10.0] — 2026-08-06 · PROTOTYPED (the assurance ceiling is closed — `verified` can finally be minted)
- **NEW `elevateAssurance()` (`principal.ts`) — the ONLY path from `low` to `verified`.** Nothing in
  the codebase had ever minted `verified`, so every `minAssurance: "verified"` tool was *statically*
  unreachable. The consequence was much larger than the hub: D14-14's `approvals.resolveExecute`
  carries that floor, so the entire **agent-write half of D14 was inert**, along with PM Phase-4 `J2`'s
  write half, `ASST-23`, `D14-17`, and Hermes' own MCP authority — one gap seen from five directions.
  Design: `docs/superpowers/plans/2026-08-06-assurance-minting-design.md`.
- Three conjuncts, all required, all **fail-closed**, none client-controllable: (1) the request
  authenticated with the new **`HUB_ASSURANCE_TOKEN`**, held only by platform-nest and ai-agents;
  (2) the principal is **not** automation; (3) the platform independently vouches over
  `POST /principal/resolve` (active, non-revoked user reached through a dual-proof-verified link).
  Identity comes from the envelope; the AUTHORITY to call it verified comes from the caller — which is
  what keeps this file's founding rule literally true, that **chat-surface envelopes can only ever mint
  `low`**, even for a WhatsApp identity whose D4 link IS verified.
- **`revocation.ts` now keeps the whole platform answer** instead of only `revoked`, and serves both
  concerns from ONE cached round-trip. Not merely a load saving: two caches could disagree inside a
  window, and the concerns fail in OPPOSITE directions (revocation open, elevation closed), so the
  cached value must distinguish "the platform said no" from "the platform never answered". Hence the
  explicit `{unavailable | resolved}` union — and `unavailable` is never cached.
- **`/admin/info` reports `assuranceElevationConfigured`**, for the same reason the D14 grant flag is
  there: absence fails closed, so an unset token looks exactly like "the D14 agent half is broken".
- **Cerbos needed no policy edit** — `resource_mcp_tool.yaml` already gates on the *value*
  `"verified"`. Deliberate: a policy change would have needed a Cerbos restart to take effect.
- ⚠ **An n8n principal is refused the tier outright** (binding §A13 ruling — the assurance gate is THE
  control keeping automation off money-spending `search.*` tools). Note the guarantee **changed
  nature**: "low by construction" is no longer structural impossibility but an explicit refusal, a line
  someone could delete. Pinned by `assurance.test.ts`; recorded at both `modules/search` sites.
- 27 new tests (**206/206 green**), including elevation end-to-end over real HTTP through `/mcp`
  against a fake platform — conjunct 1 lives in the auth branch, so only a real request proves the
  wiring rather than the rule.

### [0.9.0] — 2026-07-27 · PROTOTYPED (readable decision audit + posture surface + tool attribution)
- **NEW bearer-gated `GET /audit`** (`readRecentAudit` in `audit.ts`) — the READ side of the §8
  tool-call trail, newest-first. Every allow/deny decision with its reason was being appended to
  JSONL and exposed by no route, so the hub's accountability record existed on disk and nowhere else
  (while the console's own subtitle advertised it). A missing file reads as "no activity yet"; a torn
  last line is skipped rather than blanking the whole trail.
- **NEW bearer-gated `GET /admin/info`** — the posture the console needs: **which engine actually
  decided** (Cerbos vs the in-code fail-closed fallback — the most load-bearing fact about the hub),
  deny-by-default, assurance ranks, the D14 automation write gate stated in words, revocation
  settings, rate limits (per principal AND the 10× per-service-token ceiling), mTLS mode + peer
  allowlist + topology, tool counts by source, **Resources and Prompts** (the two primitives the
  console never showed at all), and the per-workflow `AUTOMATION_ALLOWLIST` least-privilege matrix.
  Presence flags only — no secrets, mirroring the gateway's rule.
- **Tool source attribution** — `registry.withSource()` stamps each registration GROUP so a tool
  carries where it came from (`core`/`platform-read`/`platform-write`/`pipeline`/`delivery`/`module`)
  without every call site having to agree on a label. Surfaced on the open `/tools` catalog too.
- 81 tests green (+22 from the 59 baseline; 4 new cases here).

### [0.8.0] — 2026-07-23 · PROTOTYPED
- Baseline. MCP server fronting platform-nest; OBO, Cerbos policy, Tools/Resources/Prompts, rate limit,
  revocation, mTLS, site/central. 59 dev tests.
- **Next:** OpenBao creds, Redis-backed multi-instance rate limiting.

## sync-engine-go
### [0.7.0] — 2026-07-23 · PROTOTYPED
- Baseline. Central/site reconciliation, HLC, conflict rules, RLS, bootstrap, GC; property-based + chaos
  tests on a 2-Postgres harness. Runs idle (`sync-central`).
- **Next:** activate against a real second site.

## automation (n8n)
### [0.4.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. n8n + MCP templates, scoped accounts, impact gate, event bridge, approvals suspension.
  3 flows verified e2e on the live dev stack (2026-07-15).
- **Next:** more flows; Temporal for durable orchestration.

## observability
### [0.6.1] — 2026-08-06 · DEV-VERIFIED (OBS-01 — the metrics path is live; the mail alerts can finally fire)

Five mail alert rules had been passing `promtool check rules` while **nothing evaluated them** — no
Prometheus, no collector, `OTEL_ENABLED=0`. Two mitigations depended on them and were inert:
MAIL-24's `MailAuthStreamSendFailed` (a failed sign-in email is otherwise silent and, by design,
never retried) and MAIL-26's probing alerts. Tier 1 only: `otel-collector` + `prometheus`, as a
**separate compose project** (`gaiada-otel-metrics`, the MAIL-02 Alertmanager precedent) so
`deploy.yml`'s `--remove-orphans` cannot delete it and no `COMPOSE_PROFILES` change is needed.
Deliberately NOT Loki/Tempo/Grafana/exporters — 18 services against ~12G free would be reckless, and
Alertmanager was already running with 3 valid receivers.

- **Proven end to end, not just wired:** 20 rules loaded (14 operational + 6 SLO) incl. all 5 mail
  alerts; Prometheus's Alertmanager target confirmed as the running instance; real OTel
  auto-instrumentation metrics arriving from `platform`; and one alert driven to **firing** by a
  synthetic OTLP push, then confirmed present in the live Alertmanager routed to `default-multi`.
  The injected series was tagged `obs01-synthetic` and purged after.
- **Found and fixed real drift:** the server's checked-out `alerts.yml` was **stale at 145 lines**
  against the repo's 179 — missing both MAIL-26 rules, so those alerts existed only in git. Synced;
  server and repo now agree. The same drift class MAIL-21 cleaned up, quietly re-forming.
- **NOT verified:** a real mail-triggered alert (magic links are disabled on this box, so no mail
  codepath fires organically — the feature flag was deliberately left alone rather than flipped for a
  test), and SLO burn-rate behaviour.
- ⚠️ **Incident, disclosed rather than buried.** `OTEL_ENABLED` is a **shared** `${VAR:-0}` read by
  six services. Setting it in `.env` to enable `platform` alone, then running an unscoped
  `up -d --remove-orphans`, recreated all six — including `ai-gateway-go`, which another active
  session owns. Caught via `docker inspect`, reverted, and redone as a **shell-level override on a
  service-scoped command** so only `platform` got it. Final state verified: `platform=1`, the other
  five back to `0`, `ai-gateway-go` on its original tag and healthy. Cost: five services, two brief
  restarts. Lesson: to flip a shared var for one service, never write it to `.env`, and always scope
  `up -d` to explicit service names.
- Disk 75% → 77% (~11.8G free) from two image pulls. Rollback: `docker compose -f
  docker-compose.otel-metrics.yml down`; `.env` backup retained on the box.

### [0.6.0] — 2026-07-23 · DEV-VERIFIED
- Baseline. OTel across all services; opt-in Grafana stack; SLOs; alerting; restore drill. Verified e2e
  on a live Docker stack (2026-07-15).
- **Next:** deploy to a real host; tune SLOs on prod traffic.

## infra
### [0.8.6] - 2026-08-06 - PROTOTYPED (pin the agent runner's provider; pin CI's authz engine)
- **`AGENT_SERVING_PROVIDER` pinned to `openai` on `agent-runner`.** Unset, the runner resolves
  `?? lastProvider() ?? "echo"`, and `echo` is not in `task-filer`'s `evaledProviders` - so D13
  correctly STRIPS its write tools and the assistant quietly only ever reads. No error, no log, and
  every local test still green. Same shape as `APPROVAL_GRANT_SECRET`, which was passed through for
  three services while `.env` had no value. Defaulted (`:-openai`) not required (`:?`), so an absent
  value cannot stop the stack coming up over one agent capability - and verified by rendering
  `docker compose config` with the var present-but-empty, ABSENT entirely, and explicitly set.
- **CI's Cerbos pinned to `0.54.0`,** matching compose. OBS-03 pinned production and validated the new
  `audit:` config against that version while CI still pulled `:latest` - the authz engine was pinned on
  the box and floating in the pipeline. Both versions were tested against the real policies first.

### [0.8.4] — 2026-08-06 · PROTOTYPED (REL-01 — report-renderer SBOM scoped; the attest safety net removed)

`report-renderer` is the **only** image in the estate built `FROM
mcr.microsoft.com/playwright:v1.61.1-noble`, so SBOM'ing the built image cataloged the whole
Chromium/Firefox/WebKit + Debian base on top of the app. That produced by far the largest predicate of
the nine components, and Rekor rejected it **twice** on `alpha-01.017.0040a`
(`giving up after 4 attempt(s)`, each after cosign's own 4 retries) before accepting it once on the
`0040b` re-cut with no code change — so **fragility under Rekor load, not a deterministic fault**. An
earlier diagnosis of mine called it deterministic; that was wrong and is corrected in the workflow
comment.

- **Scoped to source** (`./report-renderer`, syft `dir:` via `anchore/sbom-action`'s `path` input) for
  this component only, via a matrix conditional; the other eight still scan the built image.
  Measured locally against the same base image: **17,080,639 bytes / 826 packages →
  451,910 bytes / 229 packages, ~38x**. Microsoft owns the base image's provenance and we neither
  control nor patch those OS packages, so cataloguing them added bulk without adding a control.
- **`SYFT_JAVASCRIPT_INCLUDE_DEV_DEPENDENCIES=true` is required, not cosmetic.** `tsx` is this image's
  actual `CMD` yet is a `devDependency`, and syft drops dev deps by default — a plain source scan
  would have silently omitted the real runtime entrypoint. The Dockerfile's `npm ci` has no
  `--omit=dev`, so dev deps genuinely ship; the SBOM should describe the container, not its intent.
  Spot-checked: `playwright`, `express`, `dotenv`, `tsx`, `typescript`, `vitest`, `supertest` all
  present with real versions — scoped, not hollowed out.
- **`continue-on-error` removed** from the SBOM attest step, matching the sequencing already used for
  SLSA provenance: pull the net only once the fix is demonstrated, so a genuine future attestation
  failure is loud again **for every component**. Someone had added it to unblock `0040b`, which
  silently disabled a supply-chain gate estate-wide.
- **Honest limit:** local reproduction, not a live Rekor round-trip. The next release is the real
  test, and it will now **fail loud** rather than degrade silently. If Rekor still rejects, re-add
  `continue-on-error: true` and reopen the workflow note rather than re-diagnosing from scratch.

### [0.8.3] — 2026-08-06 · PROTOTYPED (INFRA-01 — the test-database leak, fixed at the root)

`teardownTestDb()` in `platform-nest/src/testing/setup.ts` closed its pools and **never dropped the
database**, so every test file leaked one permanently. That is the root cause of the incident where
**615 abandoned databases exhausted Docker's 64MB `/dev/shm`** and made every suite fail with a
misleading "No space left on device" while disk had 826GB free. A full run is ~210 files, so one
unmitigated run added ~210 databases; several sessions running suites concurrently is how the
threshold was reached. For two days the workaround was to tell each agent individually to use a
distinct `TEST_DB_PREFIX` and drop its own databases — N repetitions of a manual step for a
three-line defect.

- **The constraint that made the original code unfixable in place:** `admin` is a pool connected to
  the test database *itself*, and Postgres refuses `DROP DATABASE` from a session connected to it. The
  drop therefore needs a **fresh maintenance connection** to `TEST_URL` (i.e. `postgres`), mirroring
  the CREATE side of `initTestDb`. Order: close app pool → close `admin` → open maintenance → `DROP
  DATABASE IF EXISTS ... WITH (FORCE)` → end maintenance.
- `WITH (FORCE)` is required because plain `DROP` fails while any connection lingers — precisely the
  situation at teardown. Needs PG13+; the live test instance is **PostgreSQL 17.10**, confirmed.
- Wrapped in try/catch/finally so **a teardown hiccup can never fail an otherwise-passing suite**,
  matching the file's existing `.catch(() => {})` idiom.
- Recomputes the deterministic database name independently of `admin`'s state, so it is a no-op when
  teardown runs twice or setup failed partway — and now also cleans up when a database was created
  but `initTestDb` threw afterwards.
- **Verified:** all 162 `teardownTestDb` call sites checked for post-teardown database access (the 15
  where `adminPool()` co-occurs were read individually) — none rely on it. Three suites (DB-heavy,
  DB-moderate, no-DB) run twice each plus once together under `fileParallelism: false`; scoped
  database counts return to zero every time, no flakiness, no timing regression. `tsc` clean.
- The pre-existing orphan backlog was deliberately **not** mass-dropped (some belonged to other
  sessions' in-flight runs). It now sits at **1**. Count orphans with
  `datistemplate=false and datname<>'postgres'` — **not** `datname like 'test_%'`, which matches
  nothing and reported "0 orphans" for hours while ~565 existed.

### [0.8.2] — 2026-08-06 · PROTOTYPED (compose passthrough for the Hermes brain + the assurance token)
- **`HUB_ASSURANCE_TOKEN` passed through to exactly four services** — `platform`, `agent-runner`,
  `mcp-hub`, `mcp-hub-central` (optional/`:-`, so existing deployments are unaffected). Both halves are
  required: set it on the callers but not the hub and their elevated requests authenticate as ordinary
  `low` callers, with every agent write denying for a reason that reads like a code bug. Deliberately
  NOT given to `bot` or n8n — that would lift the chat-surface ceiling the design rests on.
- Documents the pairing in `.env.example` with the one warning that matters: it must be a **different
  secret** from `HUB_SERVICE_TOKEN`, since sharing them hands the chat surfaces the elevated tier.
- (Earlier, unreleased at `0047b`: `HERMES_URL`/`HERMES_MODEL` passthrough — `48a9aa7` — and writing
  the deployed tag into the box's `.env` rather than only `.deployed-tag` — `3960e88`.)

### [0.8.1] — 2026-08-06 · PROTOTYPED (the .env has two consumers and they disagree)

`alpha-01.018.0045a` built and signed all nine images, then LOST the deploy at the backup gate and
rolled a good release back. Cause: the box's `.env` had

    MAIL_STREAM_NOTIFY_FROM=Gaiada Dev <no-reply@notify.gaiada.invalid>

added by hand during MAIL-09 and never mirrored into `.env.example`. `docker compose` parses that
file ITSELF, so the value is a fine literal and the whole stack ran on it for hours. `deploy.yml`'s
backup step SOURCES the same file in bash, where `<addr>` is a redirection — so it is a syntax error
in exactly one of the two consumers. The log said only:

    ./infra/compose/.env: line 97: syntax error near unexpected token `newline'

no variable name, no mention of which consumer, and no reason compose had been happy.

Three fixes, in the order they matter:

1. **`deploy.yml` gains a `bash -n` precheck on the box's `.env`**, before backup/pull/migrate/
   rollback, naming the offending line with the VALUE REDACTED (bash echoes the line verbatim, and
   that line is by definition config). A confusing mid-deploy rollback becomes an immediate stop that
   states the rule: quote anything containing a space or any of `< > | & ; ( ) $ \``.
2. **`.env.example` gains the `MAIL_STREAM_*` / `MAIL_REPLY_DOMAIN` trio, quoted, with the
   two-consumers warning inline.** Their absence is the actual root cause — a variable that only ever
   exists on the box gets written in whatever form happens to work for the one parser its author
   tested.
3. **`KC_SMTP_FROM_DISPLAY_NAME="Gaiada Auth (dev)"` is now quoted** in `.env.example` — the same
   latent landmine (space + parens), already committed, waiting for the next `.env` derived from it.

The gate behaved correctly throughout: because the backup failed, migrations never ran, so the
rollback left NO schema/code split — the live DB stayed at `0079` while `0080`/`0081` waited. That is
the ordering working as designed, and worth stating because the rollback warning
("Schema was NOT reverted — check migrations") reads as though it might not have.

### [0.7.4] — 2026-08-03 · PROTOTYPED (one secret under two names; n8n squatting the ERP root)
- **The platform read the bot's admin token from `${BOT_ADMIN_TOKEN}` while the bot read
  `${ADMIN_TOKEN}`** — one shared secret, two `.env` names. A deployment that set only `ADMIN_TOKEN`
  handed the platform an empty string, every bot-admin proxy call 401'd, and the Systems console
  reported "bot admin unreachable" as though the bot were down (it was up and answering `/health` 200
  throughout). Now `${BOT_ADMIN_TOKEN:-${ADMIN_TOKEN:-}}`, so one name suffices. Verified live: all
  four admin routes went 401 → 200 and the console shows a real session state with event history.
- **n8n was proxied on eight ERP top-level paths** — `/webhook`, `/form`, `/mcp` and their
  `-test`/`-waiting` variants — because `N8N_WEBHOOK_URL` was the bare origin. The first platform-ui
  route to land under any of those names would have been silently answered by n8n, presenting as a 404
  on a page that demonstrably exists. Narrowed to the `/n8n/` prefix only (still outside the basic-auth
  gate, which the event bridge requires since it acks 4xx as delivered). Verified safe first: all 8
  registered webhooks are called in-cluster except `/ingest/lead`, which has never run.
- **`AUTOMATION_PUBLIC_URL`** added, so the console's "Open in n8n" link stops being derived from the
  in-cluster `AUTOMATION_URL`.
- **`*.local.md` gitignored** for operator credential notes kept beside the code.

Standing caveat, recorded because it bit this session: `deploy.yml` ships `infra/compose/*.yml`,
scripts and mounted config — **not** host nginx and **not** `automation/.env`. Those two are manual
(see `infra/nginx/README.md`).

### [0.7.2] — 2026-08-03 · IN PROGRESS (CI reached the redis it was already running; deploy unblocked)
- **`platform-nest` CI set `REDIS_URL`, but every suite reads `REDIS_URL_TEST`** (18 files). The
  redis service container was running and being ignored, so **14 test files / 146 tests had never
  once executed in CI** — they skipped themselves silently. Only visible because TR-29's preflight
  deliberately converts that skip into a loud failure. Same URL, correct name. Un-skipping them
  immediately surfaced a real bug — see `reports` 0.3.1.
- `infra/scripts/wire-env.sh` — the one piece of the live box that was not reproducible from the
  repo (it existed only as `~/gaiada/wire-automation.sh` on gda-aicenter). Generalised to a service
  list + a `VERIFY` regex. Encodes two traps: `docker compose restart` does NOT re-read `.env`
  (compose bakes the environment at container *create* time, so a restart re-runs the old
  environment while looking like it worked — only a recreate re-reads the file), and the VPS
  invocation needs `-f docker-compose.hostdata.yml --profile bot --profile auth` or postgres/redis
  are profile-disabled and compose rejects the project. It reports explicitly when NONE of the
  expected vars are present, because that is the signature of a missing compose passthrough rather
  than an unset value — the shape that has now bitten four times (Google/Ads credentials,
  `N8N_BRIDGE_TIMEOUT_MS`, `MEETING_VIDEO_MAX_BYTES`, `N8N_BRIDGE_ENTITY_TYPES`).
- **Deploy unblocked.** `RENDERER_TOKEN` is `${RENDERER_TOKEN:?}` in `docker-compose.vps.yml`, so
  its absence from the box's `.env` made `docker compose` refuse the ENTIRE project, not just the
  new sidecar. Minted on gda-aicenter alongside `PLATFORM_UI_INTERNAL_URL` / `REPORT_RENDERER_URL`;
  `docker compose config` now resolves against the live `.env` with no mandatory var missing.
- Runbook: added a "changing a variable in `.env` on a running box" section, and **discharged the
  `report-renderer` "unverified on the production Linux VPS" caveat** — built and exercised on
  gda-aicenter itself (Docker 29.7.0, linux/amd64): a real 16 624-byte `%PDF-` from
  `chromium.launch()` → `page.pdf()`, 403 on a foreign origin (SSRF guard), 401 without a token.

### [0.7.1] — 2026-07-31 · IN PROGRESS (WAHA image bump 2026.6.2 → 2026.7.2)
> Numbering note: this jumps from `0.5.2` because the registry table in `MODULES.md` was advanced
> to `0.7.0` by the trial-deploy/nginx work without matching entries here. The table is the source
> of truth, so this entry continues from it rather than from the last logged entry.
- Bumped the pinned WAHA image `devlikeapro/waha:noweb-2026.6.2` → `noweb-2026.7.2` in
  `infra/compose/docker-compose.vps.yml`. Deliberate bump, still pinned — never `:latest`.
- **This is not a re-test of the ruled-out 2026.7.1.** The 2026-07-29 incident
  (`docs/runbooks/wa-ban-recovery.md`) established that 7.1 failed byte-identically, so the re-pair
  failure is not a minimum-client-version rejection. 2026.7.2 is a later release (published
  2026-07-29) whose changelog names a NOWEB **"WhatsApp Web version compatibility"** fix plus a
  message-timestamp/sorting fix. Taken to stay current with WA-side protocol drift — the one thing
  a pinned Baileys build silently rots against.
- **Status is IN PROGRESS, not DEV-VERIFIED.** Only `docker compose config` was validated (resolves
  cleanly, all profiles). No live pairing was exercised: the number is still out of the loop and dev
  runs against the WAHA sim. Re-pair remains **UNPROVEN** until a QR scan actually succeeds. If the
  same `Connection Failure` registration loop recurs, the upstream-block conclusion stands — stop
  the session and wait; do not bump again.
- Noted the 2026.7.x escape hatch `WAHA_NOWEB_WA_VERSION` / `WAHA_NOWEB_WA_VERSION_FORCE` (pins the
  WA Web protocol version without an image change). Left unset.
- Docs updated to match: the ban-recovery runbook incident log and the WhatsApp e2e blueprint.

### [0.5.2] — 2026-07-28 · DEV-VERIFIED (platform-nest test harness: per-file database)
- **The suite was untrustworthy, not the code.** Two root causes: (1) `initTestDb()` held a session advisory lock
  released only in `teardownTestDb()`, so a single failed `beforeAll` never released it and every later file blocked
  until `hookTimeout` — one flake cascaded into dozens (19 files, then 57); (2) `initialized` is module-scoped, so
  each vitest worker re-ran `DROP SCHEMA public CASCADE` on first use, landing underneath another worker's
  in-progress migration (`relation "schema_migrations" does not exist`).
- A third cause only visible once the race was fixed: 20+ files reuse literal fixture emails (`admin@a.test`), so
  ANY single-shared-database design collides on `users.email` regardless of timing — an interim global-setup fix
  still failed 16 suites for this reason.
- **Fix:** per-test-file physical database, `pgtest_f_<sha1(testPath)>`, dropped `WITH (FORCE)` and recreated +
  migrated in that file's own `beforeAll`; pools cleaned in `try/catch` so a throwing hook cannot leak connections.
  Locks, drops and unique constraints are all scoped to one file, so overlapping hooks cannot contend. The DB name
  is always the literal prefix plus a hex hash, so `DROP DATABASE` can never resolve to a real database (checked).
- **Verified:** 3 consecutive green full runs by the implementer + 1 independent re-run — 74 files / **734 tests** /
  0 failed / **0 skipped**, ~6m46s. No assertion touched or weakened; no suite skipped. A deliberately injected
  failing `beforeAll` no longer fails unrelated files.
- **Costs / leftovers:** ~7min per full run (migrations replay per file) and ~730MB across 60 reused
  `pgtest_f_*` databases that persist between runs by design (force-dropped and recreated, not accumulating).
  Schema-per-file within one database is the lighter-weight follow-up if runtime becomes a problem. One stray
  `gaiada_platform_test_h31` (7MB) is left from the interim attempt and can be dropped at any time.

### [0.5.1] — 2026-07-27 · PROTOTYPED (local test-infra in the dev override)
- **Why:** several suites could not run on a dev box at all. Cerbos published no ports (every authz
  check fails from the host), the bot's isolated Postgres published no port, and both projects' `.env`
  files pointed at a `localhost:5432/5433` Postgres that doesn't exist here (a native Windows Postgres
  squats :5433). Result: 3 bot tests failing + 7 skipped, and 104 nest tests skipped.
- **`docker-compose.local.yml`** (dev override; the VPS compose stays internal-only) now also publishes
  `cerbos` 3592/3593, `pg-bot` 55434, and adds a **disposable `redis-test`** on 56380. The test Redis is
  deliberately NOT the live one: `n8n-bridge.integration.test.ts` calls `FLUSHALL`, which would wipe the
  running event backbone.
- **`.env` wiring:** `wa-chat-bot` → `DATABASE_URL_TEST` at a dedicated `gaiada_bot_test` database (never
  the live crypto-shred store) and `DATABASE_URL` at the real `gaiada_bot` for host-run dev;
  `platform-nest` → test DB on 55433 plus `CERBOS_URL` and `REDIS_URL_TEST`.
- **Hazard found the hard way:** `docker compose -f docker-compose.vps.yml up -d platform` (VPS file
  alone) **silently unpublishes** `platform:3004`, which the host-run UI depends on — compose recreates
  the container without the override's ports. Always bring the stack up with BOTH files. Noted in
  `CLAUDE.md`.
- **Result:** wa-chat-bot 295/295 (was 285 passing, 3 failing, 7 skipped); platform-nest 700/700
  (was 596 passing, 104 skipped). No product code involved — infra + env only.

### [0.5.0] — 2026-07-24 · PROTOTYPED (agent-runner service + bot writable volumes + .env updates)
- **Workstream A+B compose changes:** NEW `agent-runner` service in `docker-compose.vps.yml` (build: ../../ai-agents, command: ["npx", "tsx", "src/runner/service.ts"],
  port 3006, restart unless-stopped). Env: AGENT_RUNNER_TOKEN, AGENTS_DATABASE_URL (knowledge_app role), MIGRATE_DATABASE_URL (knowledge_owner role),
  GATEWAY_URL/TOKEN, HUB_URL/HUB_SERVICE_TOKEN. Depends on postgres/ai-gateway/mcp-hub.
- **Bot writable group registry:** `wa-chat-bot` service: `GROUPS_FILE=/app/data/groups.yaml` (writable, points to bot-data volume), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml`
  (read-only seed). Volumes: bot-data:/app/data (NEW), ./groups.yaml:/app/config/groups.seed.yaml:ro (updated mount path from was :/app/config/groups.yaml:ro).
  Old groups.yaml file stays as the first-boot seed (boot copy logic if file absent).
- **platform service updates:** AGENTS_URL: http://agent-runner:3006, AGENT_RUNNER_TOKEN env (reuses AGENT_RUNNER_TOKEN secret).
- **`.env.example` updates:** added AGENT_RUNNER_TOKEN secret placeholder; noted that bot groups.yaml is now the first-boot seed only (registry lives in the volume).
- **Not deployed yet:** compose stack verified locally; container builds not verified on a Docker host (same caveat as ai-gateway-go).

### [0.4.0] — 2026-07-23 · PROTOTYPED
- Baseline. VPS Compose stack, Dockerfiles, local CI, backups, supply-chain pipeline (SBOM/cosign/SLSA).
- **Next:** first production deploy; GitOps; K8s/SPIFFE (target-state).

## reports
> Section opened 2026-08-03. The registry has carried a `reports` module since `0.1.0`, but no
> section existed here, so `0.1.0 → 0.3.0` (the TR tracker/reporting programme) has no per-entry
> history — rule 1 debt, recorded rather than back-filled from guesswork. Entries start at 0.3.1.

### [0.3.1] — 2026-08-03 · PROTOTYPED (seal_hash could never be verified from storage)
- **`computeSealHash()` hashed a string the stored `jsonb` can never reproduce, so `seal_hash`
  NEVER verified.** `canonicalStringify` sorted keys (correct — jsonb does not preserve key order)
  but did not drop `undefined`-valued keys the way `JSON.stringify` — the thing that actually
  writes the column — does. `Object.keys()` lists such a key, and `JSON.stringify(undefined)`
  returns the *value* `undefined`, which interpolates as the literal text `undefined`.
  `computeHeaderWarnings` returns `undefined` whenever a period has no warnings, i.e. the common
  case, so essentially every sealed period hashed as `..."warnings":undefined...` at seal time and
  as nothing at all when read back.
- **Why this mattered more than a red test:** `seal_hash` is the module's tamper evidence, and a
  check that can never reproduce is indistinguishable from one that caught real tampering. It would
  have read as "these sealed rows were altered" forever, on every period, with the rows intact.
- Diagnosed by dumping both hash inputs and diffing: byte-identical for 606 characters, then
  `"warnings":undefined` on one side and nothing on the other.
- Also closed the same failure mode for values carrying `toJSON` (a `Date` would have hashed as
  `{}` while storing an ISO string) — unreachable through `ReportDocument` today, one field away
  from reachable. Applied to `narrative.ts`'s deliberate independent copy too, where the defect is
  latent (nothing re-derives a `groundingHash` from storage yet), rather than leave a copy of
  something known-broken.
- Locked in with 4 DB-free tests asserting the invariant **over a JSON round-trip** rather than
  against a frozen digest, so they keep holding if the canonical form is ever legitimately changed,
  and so this class is catchable in 1 ms instead of only by a full live-Postgres run.
- **Verified** against real Postgres 17 + Cerbos + Redis (throwaway containers on gda-aicenter
  mirroring the CI job): **177 files / 2560 tests pass, 0 failures**. Before: 162 files, 1 failure,
  14 skipped. Found only because `infra` 0.7.2 fixed the CI redis wiring that had been skipping it.

## report-renderer
### [0.1.0] — 2026-07-31 · DEV-VERIFIED (TR-19: sidecar service + compose + CI)
- **What:** new standalone component `report-renderer/` — Node + Express + Playwright, the only
  image in the estate carrying Chromium (platform-ui's Next standalone image stays browser-free).
  `GET /health` (no auth); `POST /render {url}` behind `Authorization: Bearer RENDERER_TOKEN` →
  `chromium.launch()` → `page.goto(url, {waitUntil:'networkidle'})` → `page.pdf({format:'A4',
  printBackground:true, headerTemplate/footerTemplate w/ page numbers})`. Lifted the print
  technique directly from the working in-repo precedent `docs/blueprints/render-pdf.js` per the
  ticket brief, rather than rediscovering exact-color printing / page-fitting / footer numbering.
- **SSRF guard (the security-critical part):** `src/auth.ts`'s `isAllowedRenderUrl` requires the
  requested `url`'s origin to exactly match `PLATFORM_UI_INTERNAL_URL` — this service will render
  whatever URL it's handed, so a leaked `RENDERER_TOKEN` alone cannot turn it into a proxy against
  the internal network (mirrors ai-gateway-go's `DialContext` egress allowlist / search-crawl-go's
  egress guard, the local precedents this ticket named). `isAuthorized` never fails open on an
  unset server-side token.
- **Compose:** new `report-renderer` service in `infra/compose/docker-compose.vps.yml`
  (internal network only — no published port; healthcheck via `node -e fetch(...)` since
  curl/wget aren't guaranteed on the Playwright base image; `depends_on: platform-ui
  condition: service_started`); dev-only published port 3007 added in `docker-compose.local.yml`;
  `build: ../../report-renderer` added in `docker-compose.build.yml`.
- **`.env.example`:** added `RENDERER_TOKEN` (required) and `PLATFORM_UI_INTERNAL_URL` (defaults
  to `http://platform-ui:3005` in compose).
- **CI:** added `report-renderer` to the `ci.yml` unit-test matrix (typecheck + vitest) and to the
  `release.yml` image-build/sign/SBOM/SLSA matrix + the `deploy.yml` `COMPONENTS` cosign-verify
  list.
- **Verified without Docker:** `npm run typecheck` clean; `npx vitest run` → 2 files, **14/14
  tests green**, incl. the acceptance-criteria check that a token-less `POST /render` returns 401.
  Ran the service directly (`npx tsx src/server.ts`) and smoke-tested it live with curl:
  `GET /health` → 200; token-less render → 401; wrong-token render → 401; right-token +
  disallowed-origin render → 403 (SSRF guard); right-token + allowed-origin render → 502 with a
  clean JSON error body (no Chromium binary in that bare shell — the expected failure mode there,
  not a crash/hang).
- **Docker WAS available in this session (Docker Desktop, Windows/Linux-VM backend) — so unlike
  the ticket's assumed caveat, the container build and a real render were actually verified, not
  just assumed:**
  - `docker build -t gaiada-report-renderer:test .` → succeeds (base image
    `mcr.microsoft.com/playwright:v1.61.1-noble` pulled, `npm ci` installed `playwright@1.61.1`
    against the preinstalled browser revision, image exported).
  - `docker run -d -p 3999:3007 -e RENDERER_TOKEN=testtoken -e
    PLATFORM_UI_INTERNAL_URL=http://example.com gaiada-report-renderer:test` → container starts,
    `GET /health` → 200.
  - Full auth/SSRF matrix against the live container: token-less render → **401**; wrong-token
    render → **401**; right-token + `http://evil.example.com/` → **403**; right-token +
    `http://example.com/` (same-origin) → **200**, and `curl`'s output piped through `file`
    reported **`PDF document, version 1.4, 1 page(s)`** (12,348 bytes) — a real Chromium render,
    not a stub.
  - `docker exec ... node -e "fetch('http://127.0.0.1:3007/health')..."` → exit 0 (the exact
    compose healthcheck command works inside the image); `docker exec ... whoami` → `pwuser`
    (confirmed running as the base image's non-root user, not root).
  - `docker compose -f docker-compose.vps.yml -f docker-compose.local.yml -f
    docker-compose.build.yml config --services` (with `COMPOSE_PROFILES=data,bot,auth,multisite,
    whisper,jobs` and dummy `.env` values for every required var) → resolves cleanly, lists
    `report-renderer` among all 20 services; `config report-renderer` → confirms the intended
    image name, healthcheck, env, and `depends_on: platform-ui condition: service_started`.
  - `docker compose ... build report-renderer` then `up -d --no-deps report-renderer` →
    `docker ps` shows `gaiada-report-renderer-1  Up ... (healthy)`, published on
    `127.0.0.1:3007`. `GET /health` → 200; token-less render → 401; disallowed-origin render → 403
    — all reconfirmed through the compose-managed container, not just a bare `docker run`.
  - Test container/image torn down afterward (`docker stop/rm`, `.env` deleted from
    `infra/compose/`); no state left running.
- **NOT verified:** an actual deploy to the production Linux VPS this image is meant to run on —
  only Docker Desktop was available in this session. Re-confirm `docker compose ps` shows this
  service healthy on the real target host before relying on it there. TR-20 (print route) and
  TR-21 (one-shot token orchestration) aren't built, so no real report renders through the whole
  pipeline yet — this entry proves the sidecar's own contract (auth, SSRF guard, real PDF
  output), not the end-to-end export flow. Documented in `infra/runbooks/deploy-vps.md`.
- **Deliberate version pin:** `package.json`'s `playwright` dependency is pinned to the exact
  `1.61.1` (no `^`) to match the base image's baked-in browser revision — a caret range could
  resolve a newer patch whose browser binary isn't preinstalled there, and `chromium.launch()`
  would fail at runtime with no network egress intended for this container.
- **Out of scope by design (TR-20/TR-21, other seats):** the platform-ui print route this sidecar
  targets and the one-shot, 5-min-TTL, doc-scoped `jobToken` orchestration that mints the URL —
  `PLATFORM_UI_INTERNAL_URL` points at a real origin today, but nothing serves
  `/print/reports/:jobToken` yet.

## wa-chat-bot
### [0.9.1] — 2026-07-28 · DEV-VERIFIED (digest delivery target, async run, preview)
- **Scheduled digests were broken and nobody knew.** `schedule-state.ts` ran `CREATE TABLE IF NOT EXISTS` on the
  RUNTIME pool, which under the owner/runtime role split is `bot_app` — no rights on schema public. Every digest,
  cron included, died with `permission denied for schema public` (42501) inside `loadLastRun()` before summarizing
  anything; the empty history was the symptom. Now uses the owner DSN via `MIGRATE_DATABASE_URL` exactly like
  `PgStore.init()`, memoized (a failure is not cached). Confirmed fixed live: the 18:00 SGT cron ran successfully.
- **Delivery target may be a direct chat.** `MGMT_TARGET_RE` accepts `@c.us`/`@lid`/legacy `N-N@g.us`/`tg:` for the
  target only — a MONITORED entry must still be a real group. This enables the lowest-risk setup: deliver the
  digest to the operator's own number instead of posting into any group. Verified live end-to-end
  (`mgmtDelivered: true`, 9 groups, 0 failed).
- **INCIDENT + root fix: setting the target used to stop all ingestion.** `setManagementGroupId` wrote the target
  as a registry row, making `loadGroups()` non-null → registry mode with ZERO monitored groups (the target itself is
  never monitored) → the bot silently stored nothing. Observed live for ~2 minutes on 2026-07-28 before being
  caught and reverted; messages arriving in that window were dropped. The target now lives in its own
  `digest-target.json` (`DIGEST_TARGET_FILE`); precedence is registry `isManagement` row > standalone target >
  `MANAGEMENT_GROUP_ID`. Choosing where a digest is DELIVERED can no longer change what the bot READS. Three tests
  pin it; three older tests that encoded the unsafe "adds a minimal entry" behaviour were rewritten to the new
  contract (documented, not weakened).
- **Async run:** `POST /admin/digests/run/:slot` → 202 `{started,slot,startedAt}`, 409 if that slot is already in
  flight (two concurrent runs would double-post), errors from the detached run recorded in history instead of
  becoming unhandled rejections. The synchronous `/run-digests/:slot` is untouched — n8n's digest-fanout calls it.
- **Preview:** `GET /admin/digests/preview?chatId=&limit=` returns the digest text with no send path in the route
  and nothing persisted. Verified live: history unchanged, zero outbound sends.
- **Legacy group ids:** the chat-id validator rejected `<creator>-<created-at>@g.us`, so that group 400'd on click
  like the `@lid` DMs did. Shapes enumerated against the live store (18 `N@g.us`, 12 `N@lid`, 1 `N-N@g.us`).
- Tests 385 → **408**, `tsc` clean.

### [0.9.0] — 2026-07-28 · DEV-VERIFIED (console depth: ignore list, digests, search, paging)
Built by a 4-agent parallel run against a frozen contract (`docs/superpowers/plans/2026-07-28-wa-bot-console-depth.md`).
- **Ignore list** (`groups.ts`, own persisted `ignored-groups.json`): an ignored group is dropped before storage in
  BOTH trial and registry mode and skipped by digests, while still appearing in the snapshot so it can be un-ignored.
  `groupsSnapshot()` gains `ignored`; `discovered` now excludes ignored entries.
- **Digest history** (`digest-history.ts`, counts-only, last 50) + `GET /admin/digests` with timezone-aware next-run
  times (`next-run.ts`). **Skills catalog** `GET /admin/skills`. **Media health** `GET /admin/media/status`.
- **Search + paging:** `searchMessages` and `getMessagesPage` added to the `Store` interface and implemented for
  FileStore AND PgStore (parameterized ILIKE inside `withTenant`, so RLS still applies); `GET /admin/search`,
  plus `q`/`kind` on the chat list and `beforeTs`/`hasMore` on the thread.
- **`managementGroupId` is now a labelled select** built from registry AND discovered groups, with an explicit None.
  It falls back to free text only when there is genuinely nothing to choose — a select offering just "None" plus the
  current value would remove the ability to type an id, which is strictly worse than the text box.
- **Three defects found during integration, not by the agents:**
  1. `listChats` applied `q`/`kind` AFTER the store's limit, so filters only saw the newest N — `kind=dm&limit=8`
     returned 1 of 12 DMs and searching an older chat returned nothing. A search that silently answers "no results"
     is worse than one that errors. Now filters, then limits.
  2. **`@lid` chat ids were rejected.** The NOWEB/Baileys engine addresses most DMs by linked identity
     (`<digits>@lid`); the validator allowed only `c.us`/`g.us`/`tg:`, so all 12 LID DMs listed fine and 400'd the
     instant they were clicked. The regex was ALSO duplicated in `server.ts` and had drifted — there is now one
     definition (`isValidChatId`), imported.
  3. The kill switch answers `{actionsEnabled}` while its audit read answers `{enabled}` — see platform-ui 0.7.0.
- Tests 296 → **385**, `tsc` clean. Verified live through the ERP's own BFF: skills, media, digest next-run
  (18:00 today / 12:00 tomorrow Asia/Singapore), filters, paging, ignore-list write (reverted after), kill switch
  (restored), and a LID DM thread loading real messages.

### [0.8.3] — 2026-07-27 · DEV-VERIFIED (group names in the Chats tab + digests)
- `groupName()` consulted ONLY the registry and fell back to the raw JID. In trial mode the registry is
  empty, so the ERP's Chats tab listed groups as `1203…@g.us` while the Groups tab (which reads the
  discovery store) showed real names. It now checks registry → discovered subject → JID. Digest headers
  (`schedule.ts`) get the same benefit. Verified live: Chats now lists General, Marketplace, CLASS 7C, etc.

### [0.8.2] — 2026-07-27 · DEV-VERIFIED (session timeline: seeded from WAHA + persistent)
- **Bug:** the ERP Logs tab showed "No session events recorded yet" and the status pill read UNKNOWN, even
  with a healthy WORKING session. Two causes: the transition ring buffer was in-memory only (wiped on every
  bot restart), and it was fed *exclusively* by the `session.status` webhook — which WAHA fires only on a
  CHANGE, so a session that was already WORKING before the bot booted produced no event at all, leaving
  `/health` reporting `session: "unknown"` indefinitely.
- **`session-state.ts`:** timeline persisted atomically (tmp+rename) to `SESSION_EVENTS_FILE`
  (default `data/session-events.json`, i.e. the bot-data volume) on every append; NEW `loadSessionEvents()`
  called once at boot in `server.ts` (explicit, not lazy, so tests stay deterministic); NEW `observeStatus()`
  records a POLLED status, de-duplicated against the last known one so ERP polling can't spam the ring, and
  refusing to let `unreachable`/`unknown`/empty overwrite a real status.
- **`waha-admin.ts`:** `getSessionStatus()` feeds every REST read through `observeStatus()`, so the boot
  `refreshSelfJid()` call seeds the current status and any transition WAHA's webhook dropped is still caught
  while an operator has the console open.
- **Verified on the live stack:** after rebuild `/health` reports `WORKING` immediately, `/admin/session/events`
  carries the seeded entry, and both survive a `docker restart` with no duplicate entry. Confirmed through the
  ERP's own BFF path (`/api/admin/bot/status|session/events`).
- **Test hygiene:** `phase1/phase2.e2e` mock the store and pin `scheduleStateFile`, but `schedule-state`
  switches to Postgres whenever `config.databaseUrl` is set — so the suites passed or failed on whatever
  `DATABASE_URL` happened to be in the developer's `.env`. Both now pin `config.databaseUrl = ""`, keeping
  them on the intended file fallback (and unable to write into the live bot store).
- **Action audit: not a bug.** `/admin/actions/audit` returns `{enabled: true, entries: []}` — no mutating
  action has ever been attempted, and the audit file lives on the persistent volume. Coverage confirmed in
  `actions/executor.ts` (kill-switch, rate-limit, step-up, deny and execute outcomes all audited). The UI
  empty state now explains this instead of reading as a fault.

### [0.8.1] — 2026-07-27 · DEV-VERIFIED (discovered groups: named + persistent)
- **Bug:** the ERP Groups tab listed discovered groups as blank rows with only an Add button. Two causes: `bot.ts`
  called `noteDiscovered(chatId)` with no name (WAHA's `message` webhook carries the SENDER's `notifyName`, never the
  group subject, and `InboundMessage` has no chat-name field), and the discovery map was in-memory only, so the list
  reset on every restart.
- **NEW `src/group-names.ts`:** out-of-band subject resolution from WAHA, read-only and fail-soft (WAHA down /
  unpaired / endpoint absent → no name, never an error on the message path). One cached bulk sweep (60s TTL,
  in-flight dedup) of `GET /api/{session}/groups`, falling back to `/chats`, then bounded per-group probes.
  Shape-tolerant against the live NOWEB engine: `/groups` answers with a **JID-keyed object** (not an array),
  ids are bare strings on NOWEB and `{_serialized}` on WEBJS, subject is `subject` (NOWEB) or `name` (WEBJS).
- **`groups.ts`:** discovery persisted atomically (tmp+rename) to `discovered-groups.json` derived from
  `dirname(GROUPS_FILE)` (override `DISCOVERED_GROUPS_FILE`) so it follows the registry onto the writable volume;
  lazy hydrate on read; 500-entry oldest-first cap; NEW `setDiscoveredName()` late-binds a subject (never blanks or
  churns an existing one); re-seeing a persisted group no longer re-announces it as new.
- **Wiring:** `bot.ts` fires `ensureGroupName()` fire-and-forget per group message (no-op once known);
  `GET /admin/groups` awaits `backfillDiscoveredNames()` so the ERP shows real names on first load.
- **platform-ui `0.6.1`:** `GroupRegistry` falls back to the JID when a subject is still unresolved (was rendering a
  blank row), and seeds the registry row with the JID rather than an empty name on Add.
- **Verified on the live stack:** all 13 discovered groups resolved to real subjects on the first admin read after
  rebuild, and the list survived the restart. 32 unit tests for the two modules; bot suite green except the
  pre-existing Postgres-credential failures in this dev env.

### [0.8.0] — 2026-07-24 · PROTOTYPED (session-lifecycle admin plane + writable group registry)
- **Workstream A (WhatsApp go-live self-service, design §2):** new `waha-admin.ts` client + ADMIN_TOKEN-gated Fastify routes for session lifecycle
  (POST start, GET status, GET qr with data-URL base64, POST stop/logout/restart); all engine-tolerant (NOWEB status strings pass verbatim).
  Routes: `/admin/session/{start,status,qr,stop,logout,restart}` with responses per design spec §2.1.
- **Writable group registry:** moved from read-only compose bind mount to writable bot-data volume (`/app/data/groups.yaml`); YAML + mtime
  hot-reload unchanged; NEW `writeGroups()` validates (id regex, name/category lengths, ≤1 isManagement, ≤500 groups, atomic write);
  `discoveredGroups()` returns in-memory map of auto-discovered groups with firstSeenAt. Routes: `GET /admin/groups` (registry snapshot + discovered
  + managementGroupId), `PUT /admin/groups` (full-replace, idempotent, field-level validation 400).
- **Safe config write:** `GET /admin/config` (read-only snapshot + editable values), `PUT /admin/config {postToGroups?, managementGroupId?}` rewrites registry
  isManagement flag when managementGroupId changes (empty string clears to env fallback). **No editing of other env-backed config from ERP** (design 2.3 §2.6).
- **Session-state tracker (NEW `session-state.ts`):** extends InboundEvent with `{kind:"session", session, status, ts}`; normalizeWahaEvent maps webhook
  `session.status` events (tolerates both payload.status + payload.body.status shapes); ring buffer of last 20 transitions `{status,ts}` + WARN logs on
  FAILED|STOPPED transitions; `/health` gains `session` field (status string only, no identifiers).
- **Bot environment updates:** `GROUPS_FILE=/app/data/groups.yaml` (writable), `GROUPS_SEED_FILE=/app/config/groups.seed.yaml` (read-only seed);
  boot logic: if `groupsFile` absent and seed exists → copy seed → log one line. Existing `WHATSAPP_HOOK_EVENTS` already subscribed `message,session.status`.
- **NOT deployed yet:** bot session e2e tested (start→SCAN_QR_CODE→QR); UI surfaces pending (WS5 scope, not yet built).

### [0.7.1] — 2026-07-24 · NOWEB engine + aire-lesson hardening
- WAHA switched to the **NOWEB (Baileys) engine**, image pinned `devlikeapro/waha:noweb-2026.6.2`
  (no more `:latest` — aire hit floating-tag drift). Added `WHATSAPP_DEFAULT_ENGINE=NOWEB`,
  `WHATSAPP_DOWNLOAD_MEDIA=True` (feeds media enrichment), `WHATSAPP_HOOK_EVENTS="message,session.status"`
  (see reconnect/ban state, not just messages). Kept `RESTART_ALL_SESSIONS` + persisted `.sessions`
  volume (relink survives restart w/o re-QR).
- Bot persona renamed **Gaia → Rhea** (`BOT_NAME` default); persona still playful/professional by stakes.
- `normalize()` hardened engine-tolerant (aire lessons): `replyToBot` now also reads NOWEB-normalized
  `replyTo.fromMe`; `senderName` falls back to `_data.pushName`; **system-chat guard** drops
  `status@broadcast`/`@broadcast`/`@newsletter` (never reply there). Webhook already ACKs 200 before
  detached processing (dup-reply lesson already satisfied). +4 normalize tests; suite green.
- **NOWEB caveat:** the store must be enabled at SESSION CREATION (`config.noweb.store.enabled`), not
  via env, and final NOWEB payload shape can only be validated once a number is paired (needs the phone).

### [0.7.0] — 2026-07-24 · DEV-VERIFIED (persona + prompt-safety)
- New `src/persona.ts`: agency persona (voice adapts to stakes — playful/low-stakes, direct/work,
  firm/at-risk), scope limits, graceful decline, and an injection guard. `fence()` wraps untrusted
  content and neutralizes fence-breakout attempts; `dataNote()` marks fenced data as non-instructions.
- Wired into every chat-facing prompt: `answerQuestion` (persona + scope-narrowed — no open-ended
  general knowledge), `/know` + `/actions` skills, digest map/reduce (injection guard only, stays a
  neutral report), intent router (message fenced + "classify only, ignore embedded instructions").
- Reply gating hardened: `@bot` match changed from loose `includes()` to a standalone-token regex
  (`mentionsBot`) so "@bottom"/"x@bot.com" no longer trigger the bot. Gating unchanged otherwise:
  groups reply only on command/@mention/reply-to-bot; DMs always; non-triggered messages stored
  silently for digests. Digests remain management-only unless a group opts in / `POST_TO_GROUPS=true`.
- Config: `BOT_NAME` (default "Gaia"), `AGENCY_NAME` (default "Gaiada").
- Tests: new `persona.test.ts` + mention-hardening cases; 194 pass (3 pre-existing e2e fails are
  Postgres-auth env issues, unrelated). **Live e2e** against Ollama Cloud via the rebuilt gateway:
  in-scope Q&A answers naturally & grounded; jailbreak/prompt-leak declined w/o leaking; off-topic
  declined + redirected; at-risk prompt drew a firm, accountable reply. Bot container rebuilt + live.
- Baseline. WA + Telegram bot; scrub → crypto-shred → skills/Q&A; digests; media enrichment. Telegram live
  in dev; P5a features.
- **Blocked:** infra (OpenBao/Gemini/WAHA) + legal Gate 1 before real ingestion.

## ai-agents
### [0.7.2] - 2026-08-20 - PROTOTYPED (the agent names itself on every tool call)
- **`Envelope.agent`**, sent as `x-obo-agent`. `runAgent` fills it from the agent's OWN definition
  (`agent:${def.name}`) rather than from its callers — who correctly pass the requesting human's envelope
  and would have to remember. An attribution field that depends on every call site remembering it is one
  that will be missing exactly where it matters.
- Omitted entirely when absent, so a non-agent caller sends byte-identical headers to before.
- Gates: full suite 186/186 (45 skipped, unchanged).
### [0.7.1] - 2026-08-07 - PROTOTYPED (known near-miss tool names resolve; reads only)
- Follow-up to the recoverable-refusal loop, not a replacement - that stays as the net for everything
  not in the map. **Root cause moved the design:** the live `pm.listTasks` failure never reached
  mcp-hub, it died in `runAgent`'s allow-list check. n8n and the bot use fixed operator-written tool
  strings and cannot produce this defect class at all, so the map belongs in `ai-agents` rather than
  inside the hub's four-policy-surface authorization pipeline.
- **The security condition is the whole point:** resolution is the literal first operation on the
  model's tool name - before the allow-list, before D14-12 impact reconciliation, before
  `resolveApproval`, before `callTool`. Resolving after authorization would be a bypass. The regression
  test pins this by authorization OUTCOME, not source order, so it still fails if the call is moved and
  the code merely looks right.
- **Reads only, enforced at MODULE LOAD** (the file throws on import if an entry targets a non-read
  tool). No write can be reached by a name the model guessed. A future write near-miss is a materially
  different risk - a wrong guess could resolve to a DIFFERENT mutating action than intended - and needs
  its own owner decision, not a map entry.
- Two hand-written entries, no fuzzy matching. A guessing resolver is how a call lands on the wrong
  resource.

### [0.7.0] — 2026-08-07 · PROTOTYPED (D13 now enforces what SERVED, and asks for what it wants)
- **The D13 provider gate was satisfiable by a declaration that need not be true, and on `gda-aicenter`
  it wasn't.** `AGENT_SERVING_PROVIDER` (compose default `openai`) is what `runWriteAgent` checked against
  `def.evaledProviders` — but `openai` could not serve on that box at all: no `OPENAI_BASE_URL`/
  `OPENAI_API_KEY` (⇒ `Available()=false`), absent from `LLM_CHAIN`, and site topology strips
  gemini/claude anyway, so the effective chain was `[hermes, central-forward, echo]`. **Hermes authored
  every agent write while the gate believed the eval-cleared `openai` had.** D13's promise is "only a
  provider that passed its eval suite may author a write"; a control an env var can satisfy alone is not
  that promise.
- **Enforce against the OBSERVED provider** (`deps.lastProvider()`), keeping the declaration only as the
  cold-start seed — which closes the wire `runWriteAgent`'s own docstring already named as outstanding
  ("auto-detecting it from the Gateway response is the one remaining runtime wire"). Prefer-observed
  rather than replace-declared, because an unset declaration was itself a real failure mode (`79051ff`:
  writes go silently inert) and `lastProvider()` is undefined until the Gateway has served once. Deps
  that omit `lastProvider` — most tests — behave exactly as before.
- **A mismatch is never silent:** logged, and named in the refusal reason both ways round
  (`declared "openai", Gateway served "hermes"`), because a mismatch means a configuration is lying and
  the operator has to see which side.
- **Send the declaration as the Gateway's `provider` HINT** (`ai-gateway-go`'s `body.Provider` →
  `chain.RunWithHint`, the same wire the assistant's brain picker uses). Before this there was no way for
  the declaration to come true — it asserted a provider without asking for one. Now the runner asks, and
  the check above verifies it got it: a hinted-but-unavailable provider is skipped by the same
  `Available()`/breaker gate as any other, the chain serves instead, and the mismatch is contained rather
  than believed. Empty ⇒ no hint, byte-for-byte the old request.
- **Hermes cannot simply be enrolled instead** — measured, not assumed. Probed live on the box: Hermes
  holds the runner's JSON protocol perfectly but names tools in its OWN MCP namespace
  (`mcp__gaiada__projects_list`, not `projects.list`), so every call would fail the runner's allow-list.
  Enrolling it needs that divergence resolved first.
- 7 new tests: the live misconfiguration as a regression, **the converse** (a pessimistic declaration must
  not disable writes the actually-serving provider IS cleared for — this is "use the truth", not merely
  "be stricter"), cold-start preservation both ways, no mismatch note when they agree, and the hint being
  sent / omitted / overridden-by-reality. Suite 165 passed / 45 skipped.

### [0.6.1] - 2026-08-07 - PROTOTYPED (an invented tool name no longer kills the turn)
- **LIVE BUG.** The model called `mcp__gaiada__pm_listTasks` - a tool that exists nowhere - and
  `runAgent` threw `ToolNotAllowedError`, ending the whole goal. Refusing the call is correct
  containment; ending the turn over a recoverable naming slip is not.
- An off-list name is now fed back as a typed refusal naming the exact allow-listed tools, bounded by
  `MAX_OFF_LIST_ATTEMPTS` (2), after which behaviour is byte-for-byte the pre-fix path. **Two
  invariants do not move:** `deps.callTool` is unreachable on the recoverable branch (it `continue`s),
  and a genuine high-impact write still suspends - this block runs strictly before the impact gate.
- The cap counts TOTAL off-list guesses per goal, not per distinct name; per-name would let a model
  cycle names indefinitely, each one "the first attempt".
- `task-filer`'s prompt now names its four callable tools verbatim and warns against cross-namespace
  guessing. Hub tools were NOT renamed - `pm.createTask`/`pm.createDoc` are load-bearing across D14,
  the executable registry, `wf:report`'s allowlist and the Cerbos policy list.
- `status-reporter`/`approvals-chaser` share the same loop and are covered with no change, proven by
  driving the real def through hallucinate -> retry -> success.

### [0.6.0] - 2026-08-06 - PROTOTYPED (task-filer: the first agent allowed to propose a write)
- **`RERUN_CAPABLE_HIGH_WRITES` went from `[]` to its first entries ever** - `pm.createTask` and
  `pm.createDoc` - behind `task-filer`, a new write specialist. `high_write` is the HONEST declaration,
  not a demo hack: the hub tier answers "blast radius for the automation gate", the AgentDef label
  answers "may an LLM commit this unattended?", and since all assistant writes are proposals the answer
  is no.
- **THE BUG THAT WOULD HAVE 400'd THE FIRST REAL FILING:** `fileApproval` forwarded the agent-side label
  `"high_write"` verbatim, but the hub schema and the platform controller accept only
  `medium|high|unclassified`. `toWireImpact` now translates at the boundary, EXHAUSTIVELY over the union
  so a future variant is a compile error rather than a runtime 400. `low_write`/`read` throw rather than
  being folded into `"medium"` - no wire tier means "safe to auto-execute", so mapping them would
  fabricate a severity nobody assessed.
- **`fileOnSuspend` (default TRUE)** captures a suspended write as a `SuspendedIntent` instead of filing
  it. The default is the safety property: an omitted key, an explicit `true`, and no options argument all
  take the exact prior path, proven by test. Real args are held IN MEMORY - the agents DB must never hold
  raw tool args, and a runner restart already kills in-flight goals via `sweepInterrupted`.
- A new guard: no assistant-facing AgentDef may declare `low_write` (a `low_write` runs unattended by
  definition). It carries a **falsifiability anchor** - every name in `ASSISTANT_FACING_AGENTS` must
  resolve to a real AgentDef, so a typo cannot leave the guard silently checking nothing.

### [0.5.1] — 2026-08-06 · PROTOTYPED (entitled to mint verified principals)
- Presents the new **`HUB_ASSURANCE_TOKEN`** on hub tool calls when set, falling back to
  `HUB_SERVICE_TOKEN`. The runner is one of exactly two services entitled to elevate, because it
  carries the **triggering human's** envelope and never an identity of its own. Without this the
  agent-write half of D14 stays inert no matter what the hub supports (see `mcp-hub` `0.10.0`).
  An unset value degrades to today's behaviour — the call is still made, and denied at the assurance
  gate — rather than failing to call.

### [0.4.0] — 2026-07-24 · PROTOTYPED (agent-runner service + goal/run store + queue)
- **Workstream B agent runtime e2e (design §3):** NEW `src/runner/service.ts` Fastify microservice (port 3006, AGENT_RUNNER_TOKEN auth, mirroring knowledge/service.ts patterns).
  `buildRunnerApp(deps)` factory for tests. Env: `GATEWAY_URL/GATEWAY_TOKEN`, `HUB_URL/HUB_SERVICE_TOKEN`, `AGENTS_DATABASE_URL` (runtime role), `MIGRATE_DATABASE_URL`
  (owner role), `AGENT_MAX_CONCURRENT_GOALS` (default 1), `AGENT_MAX_QUEUE` (default 10), `AGENT_SERVING_PROVIDER` (optional override for D13 gate).
- **Data model (gaiada_knowledge):** NEW tables created by owner-DSN DDL (zero infra/DB-role changes needed, auto-grant to knowledge_app per existing pattern).
  `agent_goals` (queued|running|ok|suspended|budget_exhausted|failed|interrupted|cancelled, outcome, error_kind, approval_id, model_calls, tool_calls, budget caps,
  fan_out, blackboard jsonb for supervisor goals), `agent_runs` (full traced run per direct-specialist goal, TraceStatus, steps transcript, tools_called array).
  Indexes on (tenant_id, created_at DESC) for both.
- **Execution semantics:** supervisor → `runOrchestrator` → approval suspension → `suspended` + `approval_id`; write-specialist → `runWriteAgent` → `forced_read_only`
  (outcome notes the gate); read-specialist → `traceRun` → `agent_runs` row. Boot-recovery sweep: `UPDATE agent_goals SET status='interrupted'` for orphaned (queued|running)
  goals — deterministic, human re-triggers. In-process FIFO queue, workers unref'd, max-concurrent + max-queue gates. Typed error mapping:
  Budget → `budget_exhausted`, Approval/Suspended → `suspended`, Unknown/Planner/Model/ToolNotAllowed → `failed` + `error_kind`.
- **HTTP endpoints:** `GET /health` (agents/writeAgents/queue list), `POST /goals` (token, 202 queued), `GET /goals?tenant=uuid&limit=50` (list, newest first),
  `GET /goals/:id?tenant=uuid` (goal + blackboard + run summaries), `GET /runs/:id?tenant=uuid` (full run + steps), `POST /goals/:id/cancel?tenant=uuid` (queued→cancelled),
  `GET /metrics/agents` (collector summary + alerts). All reads tenant-pinned (no cross-tenant id probing).
- **Existing integrations preserved:** episodic store (PgEpisodicStore) auto-records every finished goal/run, D9 RAG, D11 revocation, D13 forced_read_only, D14 approvals.
  `evaledProviders` enrollment via eval suite + tool-contract check (runbook: `docs/runbooks/agent-evaled-providers-enrollment.md`).
- **DEV-VERIFIED end-to-end** (2026-07-24): agent-runner container lives; goal/run store persists on gaiada_knowledge; goal execution follows approval-suspension
  path (D14 gates untouched); D13 forced_read_only surfaces in status + UI; gateway timeout + 429 breaker work with runner calls (x-tenant-id propagated).
- **NOT deployed yet:** agent-runner container exists but not deployed; pending search-marketing build blocker for full UI-through.

### [0.3.0] — 2026-07-23 · IN PROGRESS
- Baseline. Specialist framework + supervisor + pgvector RAG; D14 safety.
- **Next:** eval harness (root gate) → memory/RAG → local-model registry → trainer.

## hermes-gateway
### [0.2.0] — 2026-07-23 · PROTOTYPED
- Baseline. Local Hermes brain via the Gateway contract; verified headless.

## capture-helper
### [0.2.0] — 2026-07-23 · IN PROGRESS
- Baseline. Capture edge: record → local Whisper → ingest → Shared Drive.
- **Next:** complete the MOM→PRD delivery pipeline tails.

## mail
### [0.0.10] — 2026-08-05 · IN PROGRESS · Design v4 amendment (architect, docs) + compose-passthrough closure + program state
- **Design → v4** (`docs/superpowers/specs/2026-08-04-zone-a-mail-design.md`) and **ticket plan →
  v4** (`docs/superpowers/plans/2026-08-04-mail-subsystem-tickets.md`): the dev build's findings
  folded back into the design authority's record. No design reversals; corrections + one new
  decision (A15). No application code in this entry.
- **Brevo signs nothing (design §7.6/§15 R3 re-scoped):** Brevo's only webhook-security mechanisms
  are URL basic-auth, a token header, or custom headers — no payload signature exists. The
  `MAIL_INBOUND_TOKEN` wall **is** the provider-documented scheme (satisfying "provider signature
  *where offered*" — none is); the HMAC verifier MAIL-13 built (`MAIL_INBOUND_SIGNING_KEY`, raw
  bytes, timestamp-bound) is **ours, defence-in-depth**, never to be presented as a Brevo scheme.
  §15 R3's "verify against real signatures" is struck; R3 now verifies the real token-wall
  configuration and adds the **attachment `DownloadToken`→bytes fetch** (Brevo sends tokens, not
  bytes; dev fixtures inline bytes; fail-closed stands — unfetchable ⇒ `pending` ⇒ quarantined ⇒
  download refused).
- **Quoted-history gap decided as A15 (new tickets MAIL-19/20):** intake's first-128KB body cap
  could truncate away a bottom-posted reply — the exact content C1 exists to capture,
  unrecoverable since raw MIME is never stored; MAIL-15 landed without the assumed render-side
  collapse, so the concern was owned by nobody. Decision: **head+tail cap at intake**
  (heuristic-free, MAIL-19) + **quote-collapse at render** (computed, never stored, MAIL-20);
  intake-side quote *stripping* explicitly rejected (a heuristic misfire would destroy the only
  copy of a human's words).
- **Attachment cap semantics RATIFIED as implemented** (`intake.ts`): over-cap/over-count
  *individual* attachment ⇒ dropped-but-visible (`rejected`/`rejectReason` stored + rendered),
  message still threads; only the *total* request cap (`MAIL_INBOUND_MAX_BYTES`, pre-parse)
  refuses a delivery. Now design text, with the visibility rider binding.
- **F1 audit corrected:** the design's F1 finding missed a THIRD live `automation_approvals`
  insert site — `search.controller.ts`'s Google-Ads change-proposal suspend path — which MAIL-06
  found and fixed with the same shared resolver (see `0.0.7`). The design now says its own F1
  enumeration must not be cited as complete.
- **APPR-01 recorded (owner-approved, cross-program, in flight):** `/approvals/[id]` per-item
  route — emailed approval links currently land on the bare `/approvals` list (`entityHref()`
  maps both approval types there with no id). Design §7.5 v4 binds the fix to BOTH halves — UI
  route AND the backend-emitted `payload.href` (MAIL-06's four sites emit `"/approvals"`;
  MAIL-05's tap only absolutises what it is handed) — and names it the mount point for MAIL-15's
  deferred approval-detail thread panel.
- **Settled verifies recorded in the design:** ex-Q-V6 — Keycloak realm import does NOT
  substitute `${env.*}` placeholders (MAIL-03's empirical proof; `configure-smtp.sh` is the
  fresh-boot path); ex-Q-V8 — `resource_agency_approval.yaml` has no `decide` action; `approve` →
  `company_admin` + `module_approver` ⇒ concretely `agency_approver` (not `group_executive`).
- **A13 vindicated in the design record:** the corpus caught three type-check-invisible defects
  before any live traffic (incl. the `<embed>` void-element bug that silently destroyed every
  byte after it) — cited at A13 and §7.6 as the permanent answer to "is the corpus worth keeping".
- **Migration fact:** mail core landed as **`0077_mail_core.sql`** (`0076` taken mid-session by
  `0076_core_google_oauth_states.sql`); design §5 + plan corrected; `migrations/README.md`
  already carries the drift record; head at writing time `0078` (the D14 resume-path program —
  now cross-referenced at §7.4: the M12 wording flip stays gated on that program *completing*).
- **Program state — the billing wall (new owner gate Q-O4):** GitHub Actions is billing-blocked
  and is the ONLY deploy path (`release.yml` signed images → `deploy.yml`; the box never
  compiles). MAIL-09 cannot execute; MAIL-10/11 and MAIL-18's gate verdict are blocked behind it;
  dev-stage exit criterion #3 (corpus shown running in CI) is committed-but-unprovable; ex-Q-V7
  stays unsettled. Plan v4 defines the **deferred live-verification batch B0–B4**, starting with
  **MAIL-21** (fix `COMPOSE_PROFILES` → `mail-dev,scan` BEFORE the first deploy — else
  `--remove-orphans` deletes mailpit+clamav — then reconcile the repo↔server drift: MAIL-03's
  compose/realm edits never synced to the server's ungitted `~/gaiada`; MAIL-02's scp'd files +
  server-only `.env.alertmanager-mail`).
- **Compose-passthrough closure (infra fix landed in-session, recorded here):** the eight
  `MAIL_INBOUND_*`/`MAIL_CLAMAV_*` vars MAIL-13 added were missing from the `platform` service
  `environment:` block and would have shipped silently disabled — now forwarded in
  `docker-compose.vps.yml`. Fourth-plus instance of this trap estate-wide; the design now binds
  the passthrough to the same ticket that introduces a var, with a grep in the AC.
- **Status discipline unchanged:** everything verified only against Mailpit/fixtures caps at
  DEV-VERIFIED; deliverability, inbox placement, and SLO claims stay UNVERIFIED; suites-green
  work behind the wall is IN PROGRESS with live legs PENDING-DEPLOY, never DEV-VERIFIED.

### [0.0.9] — 2026-08-05 · IN PROGRESS · MAIL-15 — mail surface UI (`platform-ui`)
- **`/admin/mail` list + `/admin/mail/[id]` detail** (`platform-ui/src/app/(app)/admin/mail/`),
  added to the Settings section tabs. List filters `stream`/`status`/`tenantId`/`entityType`/
  `entityId`/`since` against `GET /api/admin/mail/log`, offset-based "Load more" pagination, same
  403→"limited to administrators" convention as the existing `/admin/audit` page. Detail page
  renders an event timeline synthesized from `mail_log`'s own lifecycle columns (`queued_at`/
  `provider_accepted_at`/`delivered_at`/`attempts`/`last_error`) — there is no separate events
  table — plus the row's inbound thread (`GET /api/admin/mail/log/:id/thread`), plus the
  triggering entity as a working deep link (`entityHref()` in `lib/mail.ts`, mapping
  `automation_approval`/`agency_approval` → `/approvals` and `pipeline_run` → `/pipeline/:id`).
- **Status-chip honesty, structural not cosmetic.** `MailStatusChip`
  (`components/mail/MailStatusChip.tsx`) wraps the existing `StatusBadge` and appends "accepted by
  relay — not a delivery confirmation" whenever `status==='sent'` — the ceiling every row hits in
  dev, since Mailpit accepts and discards with no provider event feed at all (design §7.7/§13).
  Every status label in the UI is read from one `STATUS_LABEL` map in `lib/mail.ts`, so a future
  status can't quietly regress into implying delivery by being rendered ad hoc somewhere else.
- **`MailThreadPanel` (`components/mail/MailThreadPanel.tsx`) is self-contained** — an async server
  component that fetches its own data (`getEntityMailThread`/`getPortalRunMailThread`), so every
  call site is a one-line drop-in. Wired into the pipeline run workspace
  (`/pipeline/[runId]`, staff, `GET /api/:t/mail/threads`) and the portal run view
  (`/portal/approvals/[runId]`, `portal` prop, `GET /api/:t/portal/mail/threads` — the
  portal-scoped BFF read, never the elevated admin path, per design §6.1/§8A "the portal reuses
  the same rule through the portal BFF"). **Deferred, with reason:** the approval-detail surface
  has no per-item page to embed a panel into — `/approvals` decides items inline in the unified
  `ApprovalsList` component; wiring a panel there needs that component restructured, out of this
  ticket's scope. Flagged for a follow-up approvals-UX ticket rather than silently skipped.
- **Unverified-sender banner is field-driven, not hardcoded.** Every `ThreadMessageView` the BFF
  serves carries `senderVerified:false` (routing is by VERP `reply_token` only; `from_email` is
  display metadata and forgeable, design §7.6); `MailThreadPanel` and the admin detail page both
  render "Email reply — sender unverified (‹from_email›)" off that field, so the banner cannot be
  forgotten on a future consumer that reads the same message shape.
- **Absence-degrade on thread reads**, not the admin list/detail reads. `degradeThread()` in
  `lib/mail.ts` catches 404/405 and returns an empty thread — MAIL-13's thread endpoints landed
  concurrently with this ticket and the brief called them "unverified"; treating "route not there
  yet" as an empty state (never a page error) matches design §8A/A10's own framing. A 403 still
  propagates — that is a real parent-entity authorization refusal, not an absent route. The admin
  list/detail reads deliberately do NOT absorb 403 (mirrors `lib/adminData.ts`'s audit convention)
  so a non-admin sees "limited to administrators", never a silently empty log.
- **DEMO_MODE**: `DEMO_MAIL_LOG` + inbound thread fixtures added to `demoFixtures.ts`'s existing
  route dispatcher (`GET /api/admin/mail/log[/:id[/thread]]`, `GET /api/:t/mail/threads`,
  `GET /api/:t/portal/mail/threads`, the last one still refused for a staff caller exactly like
  the real portal-scope predicate refuses one). Fixture addresses use only the reserved TLD
  `*.gaiada.invalid` (design A12) — never a real domain, even in demo data. A permanent test,
  `lib/mail-demo-smoke.test.ts`, proves every one of those routes serves with zero backend.
- **Verified this session:** `npx tsc --noEmit` clean; full `platform-ui` unit suite green (1041
  tests, incl. the new smoke test); `npx next build` green with `/admin/mail` and
  `/admin/mail/[id]` both present in the route manifest; the A12 grep gate re-run scoped to every
  file this ticket touched (`lib/mail.ts`, `components/mail/*`, the two admin/mail pages, the
  pipeline/portal run-page edits, and the lines added to `demoFixtures.ts`) returns zero
  `gaiada.com`/`gaiada.online` hits.
- **Not verified — status caps at IN PROGRESS, not DEV-VERIFIED, accordingly.** No live BFF on
  gda-aicenter was reached (no server access in this ticket, the same constraint MAIL-04/05
  recorded) — "list renders/filters/paginates against the live BFF on the box" and "corpus-fed
  threads visible" are both PENDING a deploy + live walk. No deliverability or delivery-status
  claim is made anywhere in the UI copy, per design §13.

### [0.0.8] — 2026-08-05 · IN PROGRESS · MAIL-13 — inbound system-mail threads (C1), the untrusted-input pipeline
- **`POST /api/mail/inbound/brevo` is real.** Session-less, token-only (same posture as MAIL-04's
  delivery-event webhook): `MAIL_INBOUND_TOKEN` in `x-gaiada-mail-inbound-token`, constant-time
  compared, and **fail-closed when unset** — `!configured` short-circuits before any comparison, so an
  unconfigured deployment refuses every request rather than skipping the check.
- **Finding on the signature requirement (architect call wanted).** The ticket says "signature
  verification implemented to Brevo's documented scheme". Brevo **does not sign webhooks**: its
  published options for securing a webhook are (a) basic-auth credentials in the URL, (b) a
  token-bearing request header, (c) arbitrary custom headers (checked against Brevo's inbound-parse and
  webhook docs, 2026-08-04). Design §7.6's own wording — "provider signature **where offered**" —
  already anticipates this. So: the token IS Brevo's documented scheme, and an **additional**
  HMAC-SHA256 verifier over the RAW request bytes was implemented as OURS
  (`x-gaiada-mail-inbound-signature: t=<unix>,v1=<hex>` over `<t>.<body>`, timestamp-bound,
  `MAIL_INBOUND_SIGNING_KEY`; when that key is set a valid signature is REQUIRED). Dev verifies it
  against self-generated fixture signatures, exactly as the plan row states. **§15 R3's "verify
  signature validation against real signatures" has no real signature to verify against and needs
  re-scoping at staging** — most likely to Brevo's token/basic-auth mechanism, or to the IMAP fallback.
- **The VERP token is the only match key.** `reply+<token>@` local part → `mail_log.reply_token`;
  `from_email` is stored purely as display metadata and is consulted by nothing. Corpus-pinned both
  ways: a forged sender with a valid token threads, and a genuine sender carrying another mail's token
  threads onto **that other mail**, not their own.
- **Idempotent on `(provider, provider_message_id)`**, and the `ON CONFLICT DO NOTHING` decision runs
  BEFORE sanitizing, scanning or quarantine writes — a replayed delivery re-scans nothing and
  re-writes no bytes, which the test asserts on the storage keys, not only on the row count.
- **Raw MIME is never stored.** New `src/mail/inbound/html-sanitize.ts` is a tokenize-and-**REBUILD**
  sanitizer, not a strip-the-bad-parts filter: the output is constructed from an allowlisted tag set
  plus HTML-escaped text, so no attribute other than a scheme-validated `a[href]` (decoded BEFORE the
  scheme test) can appear, and `script`/`style`/`svg`/`math`/`iframe` are excised with their content
  while unknown-but-harmless tags are unwrapped so a human's words survive. `<img>` is not
  allowlisted, which is what closes the remote-tracker case. No new dependency.
- **Attachments → quarantine + scan gate** (consumes MAIL-14). Bytes go to a `mail-quarantine/` prefix
  of the existing file store, deliberately NOT a `files` row (that table is tenant-scoped FORCE-RLS and
  these bytes are unauthenticated, unlisted content whose only read path is the gated endpoint).
  Gate: `clean` serves · `infected` refused at EVERY privilege and its bytes never written to disk ·
  `pending` (clamd down/absent/timeout) stays quarantined at every privilege — "unscannable stays
  quarantined" · `skipped` (scanning off) admin-only. Per-attachment and count caps DROP the offending
  attachment and still thread the message (only the total-delivery cap refuses a whole delivery);
  rationale recorded in `inbound/intake.ts`.
- **A9 honoured strictly:** absent/unknown token ⇒ counter + log + **204**, with a response
  byte-identical to the matched case so the endpoint is not a token oracle. The log line deliberately
  omits the presented token.
- **NDR classification requires TWO independent signals** and only a 5.x.x enhanced status yields
  `status='bounced'` + suppression, because the harmful failure direction is a FALSE positive (a
  crafted reply suppressing a real recipient's address is mail denial-of-service). A fixture beyond the
  spec's list pins that a human reply *talking about* a bounce is not classified as one. NDR rows are
  stored with a NULL entity so a bounce can never render behind the "sender unverified" banner on an
  approval/portal surface; it shows only in the admin log thread.
- **Thread reads authorize against the PARENT entity (A10)** through one shared
  `src/mail/thread-authz.ts` that reproduces each parent surface's own `authorize()` call shape
  (including `module='hr'` for hr-origin automation approvals and `module='agency'`), so the rule
  cannot drift between the four consumers. New: `GET /api/:t/mail/threads`,
  `GET /api/:t/mail/messages/:messageId/attachments/:index`, `GET /api/:t/portal/mail/threads`,
  `GET /api/admin/mail/log/:id/thread`. The admin route requires elevation **and** the parent check
  when the mail has an entity. The portal route uses the portal's own kernel (Cerbos `portal` read plus
  `resolvePortalScope` ownership applied to the run) and 404s — not 403s — for another client's run.
- **New env, all in `src/config.ts`:** `MAIL_INBOUND_SIGNING_KEY`,
  `MAIL_INBOUND_SIGNATURE_TOLERANCE_S`, `MAIL_INBOUND_MAX_ATTACHMENT_BYTES`,
  `MAIL_INBOUND_MAX_ATTACHMENTS`, `MAIL_INBOUND_RATE_PER_MIN`, `MAIL_CLAMAV_HOST` / `_PORT` /
  `_TIMEOUT_MS`. **NOT added to `infra/compose/docker-compose.vps.yml` (a devops agent owns that file
  this session), so they are currently silently disabled on the box — the standing
  compose-passthrough trap. Follow-up filed in the ticket report.**
- **Committed adversarial corpus — a deliverable, not scaffolding (A13).**
  `platform-nest/src/mail/__fixtures__/inbound/`, 15 provider-shaped fixtures covering every case
  design §7.6 enumerates, each carrying its own `_meta.title/covers/expect` so a case can never drift
  from its reason for existing. Bulky cases are realistic-sized and the TEST scales the cap rather than
  committing a 5 MB blob. Replay script `npm run mail:replay-inbound -- --base <url>` added (exit code
  1 on any unexpected status; it prints the SQL to verify rows, because a 204 is not a pass). Wired
  into CI as a named fail-fast step, `npm run test:mail-corpus`.
- **THREE real defects the corpus found and this ticket fixed** (all in the new code, all invisible to
  typecheck): (1) the stand-in body handed to Fastify's parser was the string `"{}"`, so
  `Buffer.concat` threw `ERR_INVALID_ARG_TYPE` inside a stream callback — not an error response but an
  unhandled rejection, so every inbound request **hung** for 20s instead of replying; (2)
  `content-length` was not rewritten to match that stand-in stream, so Fastify raised "Request body
  size did not match Content-Length" and 500-ed every post; (3) `embed` sat in the subtree-drop set
  despite being a VOID element, so the scan for a `</embed>` that cannot exist ran to EOF and a mail
  containing `<embed>` silently lost every byte after it — including the human's reply. All three are
  now pinned by tests.
- **Evidence:** `npx vitest run src/mail` → **15 files, 135/135 passing** against live Postgres and
  Cerbos, including the 22-case corpus suite, a 15-probe thread-authorization suite (each probe asserts
  the thread status EQUALS the parent surface's status for the same caller, cross-tenant included), 21
  sanitizer unit tests, and every pre-existing MAIL-04/05 suite plus the A12 grep gate.
- **Caps at IN PROGRESS. Explicitly NOT claimed:** the replay script has never been pointed at a
  deployed box — **PENDING-DEPLOY**; the corpus is committed to CI but **cannot be shown running**
  while GitHub Actions is billing-blocked, so dev-stage exit criterion #3 stays **OPEN**; real Brevo
  payload fidelity and real signatures (§15 R3), real relay NDR format (§15 R4), and the live clamd
  path (MAIL-14 proved that on the box; here a stub scanner drives the same interface) are all
  unverified by this ticket. Brevo also hands out attachment `DownloadToken`s rather than bytes, so real
  attachment ingestion needs a token→bytes fetch behind the existing `NormalizedAttachment` seam —
  added to the §15 R3 surface.

### [0.0.7] — 2026-08-04 · IN PROGRESS · MAIL-06 — decider notifications on approval creation (the F1 fix)
- **F1 closed for real.** Before this ticket, creating an approval notified nobody: `automation_approvals`
  create had no `notify()` call and neither did either `agency_approvals` INSERT path — the approvals
  inbox was pull-only on the request side, and MAIL-05's tap had nothing to fire on. This ticket adds the
  bell notification AND gives MAIL-05's `approval.requested` tap its first real emitter.
- **New file `platform-nest/src/core/approval-deciders.ts`** — `resolveAutomationApprovalDeciders(tenantId,
  module?)` and `resolveAgencyApprovalDeciders(tenantId)`. These are explicitly a NOTIFICATION-ROUTING
  MIRROR of Cerbos, not an authorization check (Cerbos stays authoritative; every decide/approve endpoint's
  `authorize()` call is unchanged) — the file header names the exact policy files + actions it mirrors and
  says why a silent divergence would matter:
  - `cerbos/policies/resource_automation_approval.yaml`'s `decide` action: `company_admin` (global or this
    company) + `group_executive` (**global ONLY** — `derived_roles.yaml` has no company-scoped branch for
    it), **plus**, when `module=='hr'`, `module_manager` — concretely the role literally named
    `'hr_manager'` (WSD-2, the providing unit's hr_manager).
  - **ex-Q-V8, answered by reading the policy file (it is in-repo and dev-provable, per design §14):**
    `cerbos/policies/resource_agency_approval.yaml` has **NO `decide` action at all** — its DECIDE-equivalent
    is named `approve`, granted to `derivedRoles: ["company_admin", "module_approver"]`. `module_approver`
    string-composes `"<module>_approver"` (`derived_roles.yaml`); `agency.controller.ts` always passes
    `module: "agency"` for `agency_approval` resources, so the concrete role is `'agency_approver'`.
  - Both resolve against `user_roles`/`roles` (the same global tables `rbac/principal.ts`'s
    `assemblePrincipal` reads), `SELECT DISTINCT ur.user_id` **plus a second `Set`-based dedupe in JS** —
    belt-and-suspenders against the documented duplicate-role-row defect (memory "NULL defeats UNIQUE
    constraints": migration 0073 only prevents two *global* rows sharing a name going forward; a global
    row and a company-scoped row of the SAME name for the SAME tenant is a legitimate, still-possible
    two-row shape, and a decider matching both must still get exactly one notification, not two — pinned
    by a dedicated test).
- **Four call sites wired**, all `notify(..., "approval.requested", {origin, impact, entityType, entityId,
  href: "/approvals", ...})` via `client-notify.ts`'s existing `notifyBestEffort()` (fan-out, per-recipient
  try/catch, never throws into the caller's committed write):
  1. `core/automation-approvals.controller.ts`'s `create()` — the canonical WS4 hub-gate suspension path
     (origin `automation`/`agent`).
  2. `modules/hr/hr.controller.ts`'s `fileLeave()` — the **only** place an `origin='hr'` row is created
     (the controller endpoint above restricts `origin` to `automation`/`agent` only), so this is the one
     call site that must resolve the `module='hr'` decider set. Title: `"<subject> requested <type> leave"`.
  3. `modules/agency/agency.controller.ts`'s `createApproval()` (subject-review path) — the FIRST of the
     ticket's two named `agency_approvals` INSERT sites.
  4. `modules/agency/agency.controller.ts`'s `submit()` (asset-review path) — the SECOND. (Its transaction
     now also returns the computed `subject` string, not just the id, so the notification title matches
     what the row itself records.)
  - **Beyond the ticket's literal two names:** a THIRD live `automation_approvals` INSERT site exists —
    `modules/search/search.controller.ts`'s Google-Ads change-proposal suspend path (origin `automation`,
    SM-21/SM-26) — that the ticket text and the design's F1 finding did not enumerate. Left unfixed, F1
    would still be true for exactly that origin/path, so it was wired to the SAME helper + decider set for
    full-fidelity closure and called out here explicitly (not silently) for architect/QA visibility — it is
    a same-class, same-risk addition (one more `notify()` call site using the identical shared resolver),
    not a contract or schema decision.
- **Wording class follows automatically** — no new logic here: `automation`/`agent`/(this new `search`
  path) origin ⇒ MAIL-05's `wordingClassFor()` already picks `approval.warning` (D14 gap, "nothing has
  run"); `hr`/`agency` ⇒ `approval.actionable`. Verified end-to-end on the real enqueued+rendered
  `mail_log` row per origin, not just at the notification-payload layer.
- **Self-skip preserved everywhere**, including the non-obvious case: an `agency_approver` who is ALSO the
  actor creating/submitting the approval does not notify themselves, even though they are a decider —
  `notify()`'s existing `recipientId === actorId` guard, unchanged.
- **Bell substrate is unconditional** (F1's core ask): a dedicated test proves the in-app notification
  still lands with `MAIL_ENABLED=0` — only `mail_log` population is gated on the mail master switch.
- **New test file** `platform-nest/src/core/mail-06-decider-notifications.test.ts` (6 tests, all green
  against live Postgres + the live `gaiada-test-cerbos` instance): automation-origin decider fan-out +
  non-decider negative probe; hr-origin decider fan-out + the OTHER-module-manager negative probe (a
  `finance_manager` gets nothing on an hr-origin row — proves the module_manager mirror is scoped tightly
  to `module=='hr'`, never "any `*_manager`"); both agency paths incl. self-skip-while-decider; the
  duplicate-role-row dedupe probe; the `MAIL_ENABLED=0` bell-still-fires probe.
- **Regression suites re-run, all green, zero changes needed:** `automation-approvals.test.ts` (6),
  `approvals.test.ts` (9), `approvals-decide.test.ts` (7), `client-notifications.test.ts` (11),
  `modules/agency/agency.test.ts` (9), `agency-first-deploy.e2e.test.ts` (1), `seed/agency.db.test.ts` (3),
  `modules/hr/hr.test.ts` (16), `modules/hr/wsd7-acceptance.test.ts` (12), `mail/tap.test.ts` (11 — MAIL-05,
  untouched), `modules/search/search-sem-apply.test.ts` (36, covers the third call site) — **94 + 36 = 130
  tests, all passing**, plus this ticket's own 6.
- **Files touched:** `platform-nest/src/core/approval-deciders.ts` (new); `automation-approvals.controller.ts`,
  `modules/hr/hr.controller.ts`, `modules/agency/agency.controller.ts`, `modules/search/search.controller.ts`
  (notify wiring only — no schema/contract change, no migration); `mail-06-decider-notifications.test.ts`
  (new). **Nothing under `src/mail/` touched** (MAIL-13 was concurrently in progress there).
- **Cap: IN PROGRESS, not DEV-VERIFIED** — verified only against live Postgres + a live test-Cerbos
  instance in this session; no gda-aicenter box smoke was run here (that live-box proof, "suspend a test
  automation write ⇒ decider's warning mail in Mailpit", is MAIL-09's job, not this ticket's).
- **Contract:** `docs/FRONTEND-BFF-CONTRACT.md` §17 updated — `approval.requested` is no longer
  "not yet emitted by any caller"; it now fires from all four (four, not two) creation sites above.

### [0.0.6] — 2026-08-04 · DEV-VERIFIED (this leg only) · MAIL-02 — Alertmanager email against the Mailpit sink
- **The non-obvious fix:** Alertmanager's `global.smtp_require_tls` defaults to `true`, which
  flatly refuses a TLS-less smarthost — including the dev-stage Mailpit sink (authless, plaintext,
  MAIL-00) — and the resulting failure reads like a config problem, not a TLS-policy decision.
  Added `smtp_require_tls: ${SMTP_REQUIRE_TLS}` to `infra/observability/alertmanager/
  alertmanager.yml`'s `global:` block, with a comment recording why the earlier "don't edit
  compose" guidance is superseded by this one line.
- `SMTP_REQUIRE_TLS: ${SMTP_REQUIRE_TLS:-true}` (secure-by-default — an unset var never silently
  downgrades TLS against a real relay) added to the `&am_env` anchor in
  `infra/compose/docker-compose.observability.yml`, and to `.env.example`'s D15 alerting block.
- **New standalone compose project** `infra/compose/docker-compose.alertmanager-mail.yml`
  (`name: gaiada-alertmanager`) running ONLY `alertmanager-render` + `alertmanager` — the full WS9
  observability stack (Prometheus/Tempo/Loki/Grafana/exporters) is deliberately NOT brought up on
  gda-aicenter; full observability stays opt-in. Attaches to the main stack's network via
  `networks.stack: {name: gaiada_default, external: true}` — the n8n precedent
  (`automation/docker-compose.yml`), so a separate project survives the main project's
  `--remove-orphans`. Alertmanager UI published loopback-only (`127.0.0.1:9093`), matching every
  other admin surface on the box.
- Server-side env for this project lives in a new, **ungitted** `infra/compose/
  .env.alertmanager-mail` on gda-aicenter: `SMTP_SMARTHOST=mailpit:1025`,
  `SMTP_FROM=alerts@notify.gaiada.invalid`, empty SMTP auth, `SMTP_REQUIRE_TLS=false`. The
  Telegram/ntfy/generic-webhook/dead-man's-switch transports this ticket does not exercise are
  given deliberate `*.invalid` placeholder values (not real credentials) purely so every receiver
  in the rendered config stays syntactically valid — email is the only transport proven against
  real infrastructure here.
- **Evidence, executed on gda-aicenter:**
  - `docker exec gaiada-alertmanager-alertmanager-1 amtool check-config /etc/alertmanager/
    alertmanager.yml` → `SUCCESS … Found: - global config - route - 0 inhibit rules - 3 receivers
    - 1 templates`. All three receivers present (`default-multi`, `page-all`, `deadmansswitch`) —
    the Telegram and ntfy legs are config-valid, not deleted, to make email work.
  - A synthetic alert fired via `POST /api/v2/alerts` (`alertname=MAIL02SyntheticProbe`) landed in
    the Mailpit API within the `group_wait` window: message `From: alerts@notify.gaiada.invalid`,
    `To: ops@notify.gaiada.invalid`, `Subject: "[FIRING:1] MAIL02SyntheticProbe
    mail-02-devops-ticket (warning)"` — captured via `GET /api/v1/messages`, then resolved
    (`endsAt`) for hygiene. The Telegram leg failed as expected (`401 Unauthorized: invalid token
    specified` — the deliberate placeholder token), which did not block the independent email
    notifier in the same receiver.
  - **Survives a platform deploy:** ran the real deploy-equivalent command with the actual repo
    variables (`COMPOSE_PROFILES` and `COMPOSE_FILES` read live via `gh api` —
    `bot,auth,whisper,mail-dev,scan` / `-f docker-compose.vps.yml -f
    docker-compose.hostdata.yml`): `COMPOSE_PROFILES='bot,auth,whisper,mail-dev,scan' docker
    compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml up -d --no-build
    --remove-orphans`. `docker ps` before/after confirms `mailpit` (part of the main `gaiada`
    project) and the separate `gaiada-alertmanager` project's `alertmanager` container were both
    unaffected — no orphan removal touched either, because they're different compose projects.
- `infra/compose/docker-compose.obs-local.yml` and `infra/observability/alertmanager/
  alertmanager.local.yml` — **untouched**, as required.
- Nothing under `platform-nest/` touched (a senior-be agent is concurrently working MAIL-13 there).
- **Cap: DEV-VERIFIED for the Mailpit-sink leg only.** No deliverability claim anywhere — the
  real-relay leg (real SMTP relay, real Telegram token, real ntfy/webhook/dead-man's-switch
  endpoints) is staging §15 R8, explicitly out of scope here.

### [0.0.5] — 2026-08-04 · IN PROGRESS · MAIL-03 — Keycloak realm SMTP against the sink, real auth flows
- **Live Keycloak realm SMTP configured (gda-aicenter)** via `kcadm` under the real `/idp` prefix
  (not `/auth`): `smtpServer` = host `mailpit`, port `1025`, from `no-reply@auth.gaiada.invalid`,
  no auth, no TLS. Confirmed DB-persisted (survives `docker compose ... up -d --force-recreate
  keycloak` — realm state, not import-derived).
- **ex-Q-V6 settled, dev-provable: realm-import does NOT substitute `${env.*}` placeholders.**
  Proved by importing a throwaway realm (`zzz-smtp-placeholder-test`) whose `smtpServer.host` was
  the literal string `${env.ZZZ_TEST_SMTP_HOST}`, with that env var genuinely set and passed
  through the keycloak service's `environment:` block — after `--import-realm` ran, the persisted
  realm still held the unexpanded placeholder string, not the env value. Test realm + the probe
  import file were deleted afterward; no residue left on the box.
- `infra/compose/keycloak/gaiada-realm.json` gains a real, working dev-default `smtpServer` block
  (the Mailpit shape — placeholders would have shipped a broken fresh-boot config given the
  verdict above) plus a `gaiada.smtp-note` realm attribute recording the verdict inline.
- New `infra/compose/keycloak/configure-smtp.sh` — idempotent `kcadm update realms/gaiada
  -s smtpServer.*` reading the container's own `KC_SMTP_*` env; the actual fresh-boot path for
  anyone who needs non-default SMTP values (documented in `docs/runbooks/idp-keycloak.md`).
- `KC_SMTP_HOST`/`KC_SMTP_PORT`/`KC_SMTP_FROM`/`KC_SMTP_FROM_DISPLAY_NAME`/`KC_SMTP_AUTH`/
  `KC_SMTP_SSL`/`KC_SMTP_STARTTLS` added to the keycloak service's compose `environment:` block AND
  `.env.example` in the same change (the compose-passthrough trap this repo keeps hitting).
- **Both flows run end-to-end on the live `erp.gaiada.online/idp` realm**, real HTTP (PKCE
  authorization-code flow through nginx, no browser tool available — curl-driven with a real
  cookie jar + PKCE verifier), disposable dev users deleted afterward:
  - *Forgot password*: `login-actions/reset-credentials` → Mailpit-captured "Reset password" mail
    → clicked the emailed action-token link → real Bearer access token issued off the resulting
    authorization code (`acr:1`; confirmed with a live `account` REST profile fetch). Reproduced
    identically under two different OIDC clients (`account-console`, `gaiada-ui`).
  - *Verify email*: created a user WITHOUT `emailVerified:true`, added `VERIFY_EMAIL` as a required
    action, logged in with a real password — Keycloak gated on the required action, sent the
    "Verify email" mail (Mailpit-captured), clicked the link, required-action redirect completed to
    a real authorization code / Bearer token, and `kcadm get users/<id>` confirmed `emailVerified`
    flipped `false → true` purely through the flow.
- **Retirement evidence:** the verify-email user proves the `gaiada-provisioner`
  admin-side `emailVerified:true` workaround CAN be retired in dev. The `gaiada-provisioner` client
  itself is **unchanged** by this ticket — retiring the workaround for real users is staging §15
  R6, explicitly out of scope here.
- **Finding flagged for follow-up, not fixed here** (outside this ticket's scope): the realm's
  "reset credentials" flow has its "Reset Password" execution set `REQUIRED`, but observed live
  behavior authenticates straight through without presenting an inline new-password entry form
  when the user already holds a password credential and no `UPDATE_PASSWORD` required action is
  queued — reproduced under both clients tested, so it reads as flow behavior rather than a
  one-off. Documented in the runbook.
- **Cap: DEV-VERIFIED against the Mailpit sink only** — no deliverability claim; the real-relay
  leg is staging §15 R1/R8 per the mail program's status-language rule.

### [0.0.4] — 2026-08-04 · IN PROGRESS · MAIL-05 — the approval/risk email tap, + a defect fix
- Design §7.2/§7.4 (binding: M9-M12). `platform-nest/src/mail/intake.ts` (new) — `mailIntake()`,
  called by `core/http.ts`'s `notify()` exactly once, AFTER its own `notifications` INSERT commits.
  - **Allowlist EXACTLY `{approval.requested, pipeline.gate.opened}`.** Everything else
    (`mention`, `comment`, `approval_decided`, and every other bell notification type) returns
    immediately with zero DB reads — probed directly in `src/mail/tap.test.ts`.
  - **Recipient email via `users.email`** — one resolution path for staff AND client-contact users
    (M10); `users` is a GLOBAL table, read via `withGlobal`, same convention as
    `admin-mail.controller.ts`/`queue.ts`.
  - **Wording class by origin (M12/§7.4):** `pipeline.gate.opened` always → `approval.actionable`
    (the type itself is the `pipeline` origin, no `payload.origin` to inspect); for
    `approval.requested`, `origin ∈ {automation, agent}` → `approval.warning` (the D14-gap
    template, no approve/reject/decide language, states "nothing has run"), everything else
    (`hr`/`agency`/missing/unrecognized) → `approval.actionable` — an unrecognized origin
    deliberately defaults to the ACTIONABLE class, never guesses the warning class. **The M12
    wording gate is re-asserted on the RENDERED output of a row the tap itself enqueued** (not
    just a hand-crafted template payload, which `templates.test.ts` already covers) —
    `tap.test.ts`'s "wording class by origin" group.
  - **Deep link (§7.5/M11):** the notification's own `payload.href` (already the correct
    staff-vs-portal ROUTE per every existing `notify()` call site) is turned into an absolute URL
    via `config.mail.linkBaseUrl` (A12 — reserved-TLD default, never a literal domain) and nothing
    else — no token, no query string, no action param. Asserted directly: the enqueued row's
    `payload.href` matches `${MAIL_LINK_BASE_URL}${route}` exactly, contains no `?`/`&`, and does
    not contain the row's own `reply_token`.
  - **Fresh `reply_token` (§7.6) on every enqueued mail** — both allowlisted types always hang off
    a real ERP entity a reply should thread onto, so `withReplyToken: true` unconditionally.
  - **No preference surface of any kind** — nothing added; approvals remain non-opt-out-able (M9).
  - **Fail-soft is enforced by the CALLER, not `mailIntake` itself.** `notify()`
    (`core/http.ts`) now captures the committed notification's typed payload, calls `mailIntake()`
    in a try/catch AFTER its own transaction commits, and only logs on failure — never rethrows.
    Test-pinned two ways: (1) force the tap's `enqueueMail` primitive to throw (module-mocked, same
    `vi.hoisted` pattern `client-notifications.test.ts` uses one level up) and assert `notify()`
    itself still resolves + the bell notification still commits; (2) the same forced failure
    through a REAL HTTP write (`POST .../pipeline/gates`, `actorSide: "client"`) still returns
    `201` and the gate is left `pending` — the hard constraint this ticket cares about most.
- **Same pass — a QA-filed defect fixed (not a new finding of this ticket's own):**
  `admin-mail.controller.ts`'s `GET /api/admin/mail/log` did not shape-check `tenantId`/`entityId`
  (`uuid` columns) or `since` (`timestamptz`) before querying — a malformed value was safely
  PARAMETERIZED (no injection, no leak) but the raw Postgres "invalid input syntax" error was
  uncaught and surfaced as a bare 500. Added `assertUuidFilter`/`assertTimestampFilter` (same
  `UUID_RE`/`Date.parse`-before-query convention as `modules/pm/pm.controller.ts` and
  `modules/search/search.controller.ts`) — a malformed filter is now a clean `400`.
  `adversarial-qa.test.ts`'s former `[DOCUMENTS DEFECT]` case (previously asserting the 500) is
  updated to assert 400 and renamed to reflect the fix; it is green.
- **Test evidence (live Postgres, this session):** `src/mail/tap.test.ts` (new, 13 tests) +
  the pre-existing `src/mail` suite (12 files, 77 tests total incl. the updated defect test) +
  `src/core/client-notifications.test.ts` (13) + `src/core/automation-approvals.test.ts` (6) +
  `src/modules/agency/agency.test.ts` (10) — **all green, zero regressions in the `notify()`
  consumers this change touches.** `npx tsc --noEmit` clean across the whole `platform-nest` tree.
  Test-DB orphan count checked before AND after (`select count(*) from pg_database where datname
  like 'test_%'` against `gaiada-test-pg`): **0 both times** — no orphaned test databases left by
  this session's runs. Ran ONLY the scoped suites above per this ticket's explicit instruction not
  to run the full 205-file repo suite (a separate harness was reported active on it).
- **Status stays IN PROGRESS, not DEV-VERIFIED** (design §13): all evidence above is against live
  Postgres + Nest's in-process HTTP injection (`app.inject`), never a deployed box. The live probe
  ("trigger a gate on gda-aicenter ⇒ mail visible in Mailpit with the correct deep link") is
  explicitly MAIL-09's ticket, not this one. This session confirmed via SSH that the
  `gaiada-mailpit-1` container is up and `healthy` on gda-aicenter, but did **not** deploy this
  change to the box — running the probe against the currently-deployed (pre-tap) code would prove
  nothing about this ticket's diff, so it is reported as **PENDING**, not faked.
- Contract: no endpoint surface changed by MAIL-05 itself (the tap is a purely internal call site
  inside `notify()`); `docs/FRONTEND-BFF-CONTRACT.md` §17 updated only for the defect fix's status
  parenthetical on the admin log endpoint's error behavior.
- Files touched: `platform-nest/src/mail/intake.ts` (new), `platform-nest/src/mail/tap.test.ts`
  (new), `platform-nest/src/core/http.ts` (notify() wiring), `platform-nest/src/mail/
  admin-mail.controller.ts` (defect fix), `platform-nest/src/mail/adversarial-qa.test.ts` (defect
  test updated to assert 400), `docs/modules/MODULES.md`, `docs/FRONTEND-BFF-CONTRACT.md`.
### [0.0.3] — 2026-08-04 · DEV-VERIFIED · MAIL-00 + MAIL-14 — Mailpit dev sink + ClamAV scan service
- Design §4.3/§7.6 (binding). Two new additive top-level services in
  `infra/compose/docker-compose.vps.yml` (inserted after `bot-media-worker`, before `volumes:` —
  the concurrently-edited `platform` service block was left untouched throughout):
  - `mailpit` (`mail-dev` profile) — `axllent/mailpit:v1.30.6` (pinned; verified via `docker run
    --rm axllent/mailpit:v1.30.6 version` on gda-aicenter before pinning). `MP_DATABASE=/data/
    mailpit.db` on a named volume so captured evidence survives restarts. SMTP `:1025` reachable
    only over the compose network (no host port at all). UI/API published
    **`127.0.0.1:8025:8025` — loopback-only, by design, never internet-reachable** (it will hold
    live password-reset/magic-link mail). Healthcheck via the built-in `mailpit readyz` subcommand
    (auto-detects its own bind interface inside the container).
  - `clamav` (own `scan` profile, deliberately NOT `mail-dev` — real inbound at staging still
    needs scanning after the sink retires) — `clamav/clamav:1.5.3` (pinned; digest-identical to
    `:stable` at pin time). This is ClamAV's **first actual instantiation in the estate** — until
    now it existed only as the webdesk-blueprint pattern. freshclam definitions persist to a named
    volume (`clamav-data`) so a restart doesn't re-download the whole signature database.
    Healthcheck via the image's own `clamdcheck.sh` (only reports healthy once clamd is up AND has
    loaded signatures; `start_period: 180s` for first-boot freshclam). Runbook note added in-code:
    webdesk C-02 upload scanning will later reuse this same service.
- `infra/compose/.env.example`: notes added for both services (no new required vars — Mailpit
  needs no credentials; ClamAV is reached by the mail module's own `MAIL_INBOUND_SCAN=clamav` flag
  once MAIL-04/13 wire it up).
- `.github/workflows/deploy.yml`: lane comment widened to list `mail-dev,scan` alongside the
  existing optional lanes, and calls out that both MUST be in the `COMPOSE_PROFILES` repo variable
  or the job's `up -d --remove-orphans` deletes them (the whisper near-miss trap, design §4.3
  standing rule 2).
- **Live evidence on gda-aicenter (not a local claim):** synced the updated compose file to the
  box, pulled both pinned images, brought them up with a deploy-shaped `up -d --no-build
  --remove-orphans` invocation (same `-f` files as `deploy.yml`, `COMPOSE_PROFILES` widened to
  include `mail-dev,scan` for this run). `docker inspect` — `mailpit: healthy`, `clamav: healthy`,
  `platform: healthy` (unaffected). A raw authless SMTP transaction (`EHLO`/`MAIL FROM`/`RCPT
  TO`/`DATA`/`QUIT`) sent from inside an already-running container over the compose network to
  `mailpit:1025` was accepted (`250 2.0.0 Ok: queued as …`) and the message appeared in `GET
  /api/v1/messages` (correct from/to/subject) via the box's loopback API. `ss -tlnp` shows `LISTEN
  127.0.0.1:8025` and nothing else on 8025/1025 — the SMTP port has no host binding at all.
  EICAR test string (written to a local file and `docker cp`'d in to avoid shell-escaping
  corruption) scanned via `clamdscan` inside the container: `Eicar-Signature FOUND`, exit 1.
  **Orphan probe:** the same deploy-shaped `up -d --remove-orphans` invocation was run a SECOND
  time; both `gaiada-mailpit-1` and `gaiada-clamav-1` showed `Running` with zero recreation —
  proof the profile mechanism itself (not just this one apply) protects them from `--remove-
  orphans`, given a correct `COMPOSE_PROFILES`.
- **Fail-soft-boot / fail-closed-exposure (MAIL-14 AC), reasoned + confirmed via `docker compose
  config`, not by actually pulling the container down on a live box:** `platform`'s `depends_on`
  (hostdata-overridden form) resolves to `cerbos` only — no dependency, health-gate, or startup
  reference to `clamav` anywhere in the compose graph. `MAIL_INBOUND_SCAN` (landed by the
  concurrent MAIL-04 session) defaults to `off` when unset, which is documented there as
  fail-closed for attachment exposure (unscannable stays quarantined). Absence of the `scan`
  profile therefore cannot block platform startup by construction; this was not exercised by
  physically stopping `clamav` on the live box to avoid unnecessary disruption to other
  concurrent sessions' work.
- **Known gap, reported rather than silently routed around:** the GitHub repo variable
  `COMPOSE_PROFILES` was NOT updated. It still reads `bot,auth,whisper` (unchanged from before
  this ticket). Both `gh variable set COMPOSE_PROFILES --body "bot,auth,whisper,mail-dev,scan"`
  and the equivalent `gh api -X PATCH .../actions/variables/COMPOSE_PROFILES` were denied by this
  session's own permission classifier (not a GitHub-side or credentials failure). The box currently
  runs both new containers only because this ticket supplied `COMPOSE_PROFILES` manually on the
  SSH command line for the apply + orphan-probe evidence above — **the persisted repo variable is
  still stale, so the next real `deploy.yml` run (once the separate GitHub Actions billing block
  in `CREDENTIALS.local.md` §9 clears) will delete `gaiada-mailpit-1` and `gaiada-clamav-1`** on
  its `--remove-orphans` step, exactly the trap this ticket exists to prevent. Fix: run
  `gh variable set COMPOSE_PROFILES --body "bot,auth,whisper,mail-dev,scan"` (append, do not
  replace, if the value has drifted further by the time this is read) before the next deploy.
- **Secret-exposure note (unrelated to this ticket's scope but surfaced while verifying `platform`
  has no dependency on `clamav`):** a `docker compose config platform` diagnostic printed the
  live `ADMIN_TOKEN` value in cleartext into this session's tool output. Flagging for the existing
  CREDENTIALS.local.md rotation queue rather than treating it as clean.
- **Status: DEV-VERIFIED** for both services against the real gda-aicenter box (design §13 — this
  is infra wiring, not mail-content delivery, so no deliverability/SLO claim is at stake either
  way). Does not touch `platform-nest/src/mail/**` or `platform-nest/migrations/**` (explicitly
  out of scope for this ticket) and does not modify anything in the `platform` service's
  `environment:` block (MAIL-04's concurrent territory).
### [0.0.2] — 2026-08-04 · IN PROGRESS · MAIL-04 — mail core module (`platform-nest/src/mail/`)
- Design §5/§4.1/§7.7/§8A (binding). Migration `0077_mail_core.sql` — **not `0076`** as the design
  doc's ledger note says: `0076` was taken out-of-band by a concurrent session
  (`0076_core_google_oauth_states.sql`) before this ticket executed; `ls migrations | sort | tail`
  re-checked immediately before writing, `0077` was free. `mail_log`/`mail_suppressions`/
  `mail_messages`, GLOBAL tables (no RLS at all, design §6.1/F2), zero backfill DML (every table
  freshly created in the same file).
- `MailProviderAdapter` seam (`src/mail/types.ts`, `provider.ts`): `smtp` (nodemailer; per-stream
  transport selection `relay`|`brevo`, A8) + `dev-log` (default when unconfigured or when
  `MAIL_ENABLED=0`). TLS rule (v3-binding): `requireTLS` forced on whenever a stream's user OR
  password is set; plaintext allowed only when BOTH are empty (the authless dev-sink hop).
- `enqueueMail()` (`queue.ts`) — the ONLY way a row lands in `mail_log` (design §6.1: no "send
  arbitrary mail" endpoint exists at any privilege). `MAIL_ENABLED=0` ⇒ true zero side effects (no
  DB write at all, not merely "nothing sent"). Suppressed recipient ⇒ a `status='suppressed'` row
  IS written (audit trail) with zero adapter calls (this function never imports `provider.ts`).
  Unknown `template_key` throws at enqueue time, not three retries later.
- Sender worker (`sender.ts`): chained-`setTimeout` sweep, `FOR UPDATE SKIP LOCKED` claim (two
  concurrent claims on one due row hand it to exactly one caller — proven with two REAL concurrent
  Postgres transactions, not a mock), `min(2^attempts,60)`-minute backoff, 5-attempt cap
  (`MAIL_MAX_ATTEMPTS`), auth-stream-first ordering (`ORDER BY (stream='auth') DESC,
  next_attempt_at ASC` — proven to sort auth first even when the notify row is MORE overdue),
  send-time suppression re-check (a suppression added AFTER enqueue still blocks the send).
- Three code templates (design A6): `approval.warning` (M12-locked wording — no approve/reject/
  decide language, explicitly states "nothing has run"; pinned by a forbidden-word-list test),
  `approval.actionable` ("your decision is needed" — pipeline/hr/agency origins), `auth.shell` (the
  base auth-stream shell later auth templates specialize). CRLF/header-injection stripped from
  every subject/header value before it reaches the adapter (`sanitize.ts`).
- `POST /api/mail/webhooks/brevo` (delivery-event intake): token-header-authed
  (`x-gaiada-mail-webhook-token`, constant-time compare, fail-closed when unset), idempotent by
  `provider_message_id` (`AND status <> 'delivered'`/`'bounced'` makes a replay a true no-op),
  204-on-unknown (unmatched id or unrecognized event shape — never a 5xx a provider would retry
  forever over). Receives nothing in the dev stage (no live Brevo) — built and tested for real.
- `GET /api/admin/mail/log[/:id]` — elevated-only (`isElevated`), filterable, 403 for non-elevated,
  404 for an unknown id on detail.
- A12 grep gate wired into the permanent suite (`grep-gate.test.ts`, not just a manual `rg` run):
  zero `gaiada.com`/`gaiada.online` literals under `src/mail/`, verified both via the vitest suite
  and a direct `rg -n "gaiada\.(com|online)" platform-nest/src/mail/` (zero matches, both ways).
- `MAIL_*` env: added to `src/config.ts`, the `platform` service's `environment:` block in
  `infra/compose/docker-compose.vps.yml`, and both `platform-nest/.env.example` and
  `infra/compose/.env.example` — the compose-passthrough trap this repo has hit repeatedly.
  gda-aicenter's compose defaults both streams at `mailpit:1025` (authless) directly, reusing the
  MAIL-00 Mailpit sink and MAIL-14 ClamAV service already present in that file (landed by a
  concurrent devops session; observed, not built or verified by this ticket).
- 49 tests green (`npx vitest run src/mail`) against live Postgres + a local fake-SMTP server
  standing in for Mailpit (no server access in this ticket). `lint:migration-rls` clean (no
  FORCE-RLS tables touched — mail tables carry no RLS at all). `tsc --noEmit` clean.
- **Status caps at IN PROGRESS, not DEV-VERIFIED** (design §13): the real Mailpit sink on
  gda-aicenter was never reached — that live smoke (enqueue → message asserted via the Mailpit
  HTTP API, authless plaintext hop working on the real box) is **PENDING-SINK**, tracked as a
  MAIL-09 follow-up, not claimed here. The `notify()` tap (MAIL-05) has not landed — nothing in the
  ERP enqueues mail on its own yet; this ticket ships the primitive MAIL-05 will call.
### [0.0.1] — 2026-08-04 · DEV-VERIFIED (seam only) · MAIL-16D — `GmailClient` seam + fixture implementation
- Design §8C/A14 (binding): dev builds ONLY the `GmailClient` interface, a fixture-backed
  implementation, and a provider-agnostic contract-test suite — no OAuth link flow, no live Google
  adapter, no UI, no migration. New self-contained directory
  `platform-nest/src/integrations/gmail/` (does not touch `platform-nest/src/mail/**`, which is
  MAIL-04's concurrent keystone build): `types.ts` (interface + decoded domain shapes), `errors.ts`
  (`GmailUnauthorizedError`/`GmailRevokedError`/`GmailRateLimitedError` w/ `retryAfterSeconds`/
  `GmailNotFoundError`), `fixture-client.ts` + `fixtures/*.json` (5-thread/8-message/4-label
  committed corpus), `contract.ts` (the shared suite MAIL-16's live adapter must pass unmodified at
  staging). Proved implementation-agnostic by running the identical suite, unmodified, against a
  SECOND deliberately-differently-built fake client (`contract.agnosticism.test.ts` — Map-keyed
  store, single-page pagination, independent corpus) — 25/25 tests green across both
  implementations (`npx vitest run src/integrations/gmail`), `tsc --noEmit` clean. Zero persistence
  of message content anywhere (M14): enforced by a static source-text scan for write/DB primitives
  plus a runtime before/after byte-identity check on the fixture corpus
  (`gmail.zero-persistence.test.ts`). README.md in that directory states plainly that
  thread/label/pagination semantics are UNVERIFIED against the real Gmail API (design §15 R7).
  Status caps at DEV-VERIFIED for the seam only — no claim about real Gmail behaviour.
### [0.0.0] — 2026-08-04 · PLANNED · design v3 (owner directive: finish the dev stage with zero external keys)
- Third same-day revision (still no code). **Nothing external blocks the dev stage anymore**: the
  v2 blockers Q-O1/Q-O2/Q-O3 stop being blockers and become rows in a new **Staging Reopen
  Register** (design §15) — ONE authoritative handover table for the staging stage, folding the
  old Q-V1–V9 verify register into it. Dev provider = **Mailpit** fake-SMTP sink as a
  `mail-dev`-profile compose service on gda-aicenter (new ticket MAIL-00; MAIL-01A/01B retagged
  STAGING REOPEN; both compose traps — env passthrough + `--remove-orphans`/`COMPOSE_PROFILES` —
  handled in the ticket). Against the sink, Alertmanager (needs a one-line
  `smtp_require_tls` template change), Keycloak (real forgot-password + verify-email flows,
  clicked through; the `emailVerified:true` workaround provably retirable for dev users), the
  mail core, the approval tap, decider notifications (F1 fix), magic links, inbound, and the mail
  UI all become **fully dev-verifiable**. Inbound is dev-driven by a committed **adversarial
  fixture corpus** (forged sender, wrong/absent/replayed tokens, oversize, hostile HTML, encoding
  attacks, quoted-reply bloat, NDR) — deliberately kept forever as the regression suite:
  higher-fidelity than a live provider for exactly those cases. Domains become config-only
  (`*.gaiada.invalid` compiled defaults + a grep gate; staging swap is env-only; new
  `MAIL_LINK_BASE_URL`). Magic links move up (W8 → W6) — dep-free against the sink; the M8 SLO
  and real-user enablement stay staging-gated (`MAIL_MAGIC_LINKS_ENABLED=0`). Gmail honestly
  flagged the program's **highest re-verification risk**: dev builds only the `GmailClient` seam
  + fixture impl (new MAIL-16D); MAIL-16/17 stay in the staging window (WD-23A-1 + internal OAuth
  client unchanged as hard gates). Status discipline hardened: Mailpit/fixture evidence caps at
  DEV-VERIFIED; deliverability, inbox placement, and SLO claims stay UNVERIFIED until the reopen
  closes. Ledger re-verified for v3: `0071` landed since the v2 check; head `0075`; mail core
  still `0076`.
### [0.0.0] — 2026-08-04 · PLANNED · design v2 (owner revision, same day)
- Design + ticket plan revised in place (still no code). Cut: email digest + channel prefs
  (staff notifications are in-app only; approval mail to a required decider is not opt-out-able).
  Re-scoped triggers: only medium+/unclassified automation suspensions (the existing WS4/D14
  impact gate — no new classifier) and human-approval asks, routed to the mirrored Cerbos DECIDE
  set per origin; clients ride the same path. D14-aware wording split (warning vs actionable;
  automation/agent stays warning until a resume path exists). Approval links: plain deep links
  behind SSO — never action buttons, reply-approval, or magic links. Widened: inbound system-mail
  threads (`mail_messages`, VERP `reply+<token>@notify.gaiada.com`, untrusted-intake hardening +
  ClamAV), `/admin/mail` log UI + entity thread panels, and a staging-ready staff Gmail read
  surface (internal OAuth app, per-user consent, no DWD, `gmail.readonly`, render-on-demand /
  cache-nothing; reconciles with the 0033 vault + WD-23A-1's staged `google_oauth_states`).
  Domains locked: `auth.`/`notify.gaiada.com` + `forms.gaiada.online`; Zone A primary = Google
  Workspace SMTP relay, Brevo failover/inbound/forms. Migrations: mail core still `0076` (adds
  `mail_messages`; drops the prefs/digest tables from the draft DDL); Gmail CHECK widening at
  build-time next-unused. Tickets re-cut to MAIL-01A/01B…18 (07/08 dropped); Opus flags: MAIL-10,
  MAIL-13 (both opus·medium).
### [0.0.0] — 2026-08-04 · PLANNED
- Registered (design only, no code). Zone A email subsystem for platform-nest: provider adapter over
  a rented relay (Brevo → ZeptoMail/SES), PG-backed queue + `mail_log`/suppressions/bounce webhooks
  (migration `0076` — re-verify at DDL time), notification email as immediate-allowlist + daily
  digest on the existing `notify()` surface, Keycloak/Alertmanager SMTP wiring (zero code), magic
  links designed for a later ticket behind an auth-stream p95 SLO gate. Three sending subdomains +
  three separate keys for reputation isolation; Zone A mail never routes through webdesk C-03.
  Design: `docs/superpowers/specs/2026-08-04-zone-a-mail-design.md` · tickets:
  `docs/superpowers/plans/2026-08-04-mail-subsystem-tickets.md`.

## mail (continued)
### [0.0.11] — 2026-08-05 · IN PROGRESS · MAIL-21 batch B0 (devops) — server↔repo reconciliation + CI restored + a load-bearing correction to 0.0.10's own claims

- **`COMPOSE_PROFILES` re-verified, not re-applied.** `gh api .../actions/variables/COMPOSE_PROFILES`
  reads `bot,auth,whisper,mail-dev,scan` — `mail-dev` + `scan` both present, matching the
  orchestrator's 2026-08-04 in-session fix. No drift, no write made.
- **Deploy-shaped `up -d --remove-orphans` executed on gda-aicenter** (real `COMPOSE_PROFILES` +
  `COMPOSE_FILES` repo vars, same already-deployed tag `alpha-01.016.0037a` — confirmed tag parity
  against `docker inspect` before running, no pull/no migrate). `mailpit`, `clamav`, and the
  standalone `gaiada-alertmanager` project's `alertmanager` container all survived, untouched
  (uptime unaffected by the command). `amtool check-config` on the rendered alertmanager config:
  3 receivers, SUCCESS.
- **Server↔repo diff, file by file:**
  - `infra/compose/docker-compose.vps.yml`, `docker-compose.observability.yml`,
    `docker-compose.alertmanager-mail.yml`, `infra/scripts/*.sh`, `infra/db/*.sh`,
    `infra/compose/keycloak/{provision-dev-users.py,provision-google-dev-client.py}`: **clean**
    (`test-all.sh` shows a byte diff that is CRLF-vs-LF only — the Windows checkout's line endings;
    content is identical, not a real divergence).
  - `infra/compose/keycloak/gaiada-realm.json`: server copy **lacks** the `smtpServer` block +
    `gaiada.smtp-note` (MAIL-03's finding that realm-import does not expand `${env.*}`).
    `infra/compose/keycloak/configure-smtp.sh`: **absent** on the server entirely. **Recorded, not
    hand-fixed** — `deploy.yml`'s sync step already `rsync`s the whole `infra/compose/keycloak/`
    tree on every deploy, so the next deploy self-heals this. Confirmed the live realm is
    unaffected either way (MAIL-03 pushed real values via `kcadm`, which is DB-persisted).
  - `infra/compose/docker-compose.vps.yml` **on the server** is missing the entire MAIL-03
    (`KC_SMTP_*`), MAIL-04/13 (`MAIL_*`/`MAIL_CLAMAV_*`, ~30 vars), and D14-04
    (`APPROVAL_GRANT_SECRET`) `environment:` passthrough blocks that exist in the repo copy.
    Confirmed via `docker inspect gaiada-platform-1`: **zero** `MAIL_*`/`KC_SMTP_*`/
    `APPROVAL_GRANT_SECRET` vars present in the running container's actual env. This is the
    expected pre-deploy state (the box is still on `alpha-01.016.0037a`, cut before this compose
    work existed) and self-heals the moment MAIL-09 deploys — recorded so B1 doesn't mistake it
    for a mystery.
  - `platform-nest/cerbos/policies/`: two files (`resource_automation_approval.yaml`,
    `resource_mcp_tool.yaml`) diverge — both are the concurrent **D14 program's** grant-aware
    policy work (D14-04/06/13), not mail's. Same self-heals-on-deploy shape (rsync + the
    deploy.yml `restart cerbos` step); noted here only because this pass touched every policy
    file in the diff sweep. One stray `resource_scope_signoff.yaml.bak.1785750553` sits
    server-side from an earlier hand-edit — harmless (wrong extension for Cerbos to load) but
    uncleaned; left in place (not this ticket's file to delete).
  - `docker-compose.alertmanager-mail.yml`: **clean**, byte-identical.
- **`.env.alertmanager-mail`** (MAIL-02's server-only secret, `chmod 600`, 10 keys) — confirmed
  present, shape diffed against `infra/compose/.env.example`'s shared `SMTP_*` block, and
  documented (keys only, no values) in `CREDENTIALS.local.md` §6a.
- **CI triggers re-enabled** (`.github/workflows/ci.yml`): `ci.yml` reads **zero** `secrets.*` —
  confirmed by grep before touching anything — so a public repo's fork PRs reaching
  `pull_request` have nothing to exfiltrate; GitHub's first-time-contributor approval gate is the
  platform default on a public, non-org repo and cannot be loosened per-repo. `push`/`pull_request`
  restored to their exact pre-cost-tuned shape (main-only, docs-paths ignored, cancel-in-progress).
- **A CI run was triggered and it FAILED — `platform-nest` job, step "Mail inbound adversarial
  corpus (A13)": `npm error Missing script: "test:mail-corpus"`.** Root-caused, not patched (out of
  scope for this ticket and off-limits per the concurrent-session boundary on `platform-nest/**`):
  **`platform-nest/src/mail/` — the entire mail module (MAIL-04/05/06/13/15/19/20's code, the
  fixture corpus, and the `0077_mail_core.sql` migration) is `git status` UNTRACKED.** So is most
  of the concurrent D14 work (`0078_automation_approval_execution.sql`,
  `src/core/approval-{deciders,executables,execute}.ts`, etc.). **This corrects a claim made in
  this module's own `0.0.10`/MAIL-13 entries** ("wired into CI as a named fail-fast step",
  "committed adversarial corpus") — those describe the *working tree*, not `git`; nothing under
  `src/mail/` has ever been committed. Consequence, stated plainly: dev-stage exit criterion #3
  ("the corpus is committed and running in CI") is not merely *unprovable* behind the billing wall
  as `0.0.10`/the ticket-plan v4 state it — it is currently **false regardless of billing**,
  because there is nothing in version control for a checkout to pick up. Every "code-complete
  (PENDING-DEPLOY)" ticket status recorded for MAIL-04/05/06/13/15/19/20 describes code that
  exists only in this shared working tree: a fresh clone, a lost working tree, or `release.yml`
  building from `main` today would all produce a platform image with **none** of the mail module
  in it. This is a bigger blocker than Q-O4 ever was, and closing it (committing the module) is
  outside this devops ticket's remit — flagged here for whoever owns `platform-nest/src/mail/` and
  the D14 program to act on before MAIL-09 or any release build is attempted.
- **Runbook note:** the box's disk stayed at 76% / 12G free throughout (unchanged by the
  `up -d` proof-run); `GAIADA_TAG`/`APP_VERSION` in the server `.env` matched the running
  container and `.deployed-tag` before that command ran (no stale-tag rollback risk taken).
- **Not done, deliberately:** no release tag cut, no `deploy.yml` trigger, no fix to the
  `test:mail-corpus` script or any file under `platform-nest/**`/`platform-ui/**`.

## mail (continued)
### [0.0.12] — 2026-08-05 · IN PROGRESS · MAIL-22 (senior-db) — FORCE-RLS invariant restored on the mail tables

- **The gap:** `src/db/rls.test.ts`'s estate-wide "every tenant-scoped table has FORCE RLS" invariant
  selects every `public` table carrying a `tenant_id` column and asserts `relforcerowsecurity`.
  `mail_log` and `mail_messages` (both nullable `tenant_id` — auth mail has none) had **no RLS at
  all**, added that way by MAIL-04's original design (v3 §5/§6.1, finding F2): a NULL `tenant_id`
  row is invisible under the platform's standard `tenant_isolation` policy to every reader,
  permanently, so the original cut concluded these three tables must carry no RLS whatsoever. That
  reasoning was right about the standard policy and wrong about the conclusion — it is the one
  failing test in an otherwise fully green regression run.
- **The fix — the 0015 GUC-gate pattern, mirrored exactly.** Amended
  `platform-nest/migrations/0077_mail_core.sql` **in place** (not superseded by a new migration:
  the file was committed this session but had never been applied to any persistent database, only
  ephemeral per-test-file DBs, so amending keeps the ledger at one coherent migration — README rule
  4 does not apply). All three tables (`mail_log`, `mail_suppressions`, `mail_messages`) now get
  `ENABLE`+`FORCE ROW LEVEL SECURITY` plus a `mail_context` policy gated on a NEW dedicated GUC,
  `app.mail_context`, unconditional on `tenant_id` — the policy does not distinguish NULL from any
  other tenant value, only whether the connection opted into mail context at all. This is the same
  shape `0015_site_subscriptions_rls.sql` uses for the sync engine's `app.sync_context`.
- **A new DB wrapper, not a change to `withGlobal`.** `withMailContext()`
  (`platform-nest/src/db/index.ts`) runs `fn` inside its own transaction and sets
  `app.mail_context = 'on'` with SET LOCAL semantics (`set_config(..., true)`) — shaped like
  `withTenants` but with a fixed value instead of a tenant list. Deliberately a SEPARATE function
  from `withGlobal` rather than a flag on it: `withGlobal` has no transaction of its own (each call
  is autocommit), so there is nowhere on that path to hang a GUC that survives to a second query,
  and folding this in would force every OTHER `withGlobal` caller (`users`, `identity_links`) into
  a transaction it doesn't need, or leak the GUC session-wide to a borrowed pooled connection.
  Every mail-table query in `src/mail/**` now goes through `withMailContext` —
  `queue.ts` (`enqueueMail`), `sender.ts` (`claimDueMail`/`markSent`/`markFailedOrRetry`/
  `processClaimedMail`), `admin-mail.controller.ts` (log list/detail/thread), `thread.controller.ts`
  (entity + portal thread reads, attachment lookup), `webhook.controller.ts` (delivery events), and
  `inbound/intake.ts` (VERP token lookup, message insert, NDR apply) — while `mail/intake.ts`'s
  read of the GLOBAL `users` table (recipient email resolution) correctly stays on `withGlobal`,
  unchanged. `sender.ts`'s `claimDueMail` also dropped its own now-redundant inner
  `BEGIN`/`COMMIT`/`ROLLBACK` (it was nesting inside `withMailContext`'s transaction).
- **Honesty about what this buys, stated in the migration header and here:** the GUC gate does not
  make mail data unreadable to code that sets `app.mail_context` — any path that calls
  `withMailContext` gets in, same as `withGlobal` did before. What it restores is DEFENCE IN DEPTH:
  a future query against these tables through the ordinary `withGlobal`/`withTenants` helpers (code
  that forgot this table needs its own context) now fails closed — zero rows on read, a
  `WITH CHECK` violation on write — instead of silently succeeding. Application-layer authorization
  (the elevated-only admin log; the A10 parent-entity check in `thread-authz.ts`) remains the
  PRIMARY gate, unchanged by this ticket.
- **Proof, not assertion — `src/mail/migration.test.ts`:** replaced the stale "`mail_log` has NO
  row-level security" test (now false) with three: (1) all three tables carry
  `relrowsecurity`+`relforcerowsecurity` true; (2) a connection that never sets
  `app.mail_context` (`withGlobal`) sees ZERO existing `mail_log` rows and gets a
  row-level-security error on INSERT — the defence-in-depth proof; (3) a connection using
  `withMailContext` can insert, read back, AND update a NULL-`tenant_id` (auth-stream) row — the
  binding "auth mail keeps working" proof MAIL-22 was scoped to protect, cross-checked against the
  superuser `adminPool()` view to rule out a false-positive from the mail-context connection's own
  eyes.
- **Verification, real output, scoped per the shared-cluster runbook** (`TEST_DB_PREFIX` set,
  never the full suite): `npx vitest run src/mail src/db` → **26 files / 274 tests, all green**,
  including `src/db/rls.test.ts` **unmodified** (5 tests) now passing the "every tenant-scoped
  table has FORCE RLS" assertion for real, and `src/mail/migration.test.ts` (8 tests, the 3 new
  ones among them). `npm run lint:migration-rls` → OK (0077 has zero backfill DML — no
  UPDATE/DELETE/INSERT...SELECT — so the now-genuinely-applicable RLS lint still finds nothing to
  flag). `npm run lint:withtenants` → OK, unaffected (mail doesn't gain any new `withTenants` call).
  Twenty per-file test databases created under the run's `TEST_DB_PREFIX` were dropped afterward
  (`DROP DATABASE ... WITH (FORCE)`); confirmed zero remaining under that prefix on the shared
  `gaiada-test-pg` instance.
- **Not touched, deliberately:** the concurrent D14 session's files
  (`src/core/approval-execute*.ts`, `approval-executables*.ts`, `d14-06-*.ts`, `hub-client.ts`,
  `0078_*.sql`, `events/consumer.service.ts`, `approvals-decide.test.ts`, the two Cerbos policy
  files, `mcp-hub/**`) and the AI-chat session's `ai-gateway-go/**`. `src/main.ts` and
  `src/core/automation-approvals.controller.ts` were left as found (deliberately uncommitted,
  interleaving mail + D14 work) and were not committed by this ticket. One real cross-boundary
  note for whoever owns it next: `src/core/mail-06-decider-notifications.test.ts` (MAIL-06,
  outside `src/mail/` and outside this ticket's read/verify scope) exercises the real
  `notify() → mailIntake → enqueueMail` write path through the live app and was reasoned through
  by code inspection rather than executed here (it reads `mail_log` only via the superuser
  `adminPool()`, so it is expected to keep passing, but was not run as part of this ticket's
  scoped `src/mail src/db` command).

## mail (continued)
### [0.0.13] — 2026-08-05 · IN PROGRESS · MAIL-23 (senior-be) — drift guard for the Cerbos decider mirror

- **The gap:** `src/core/approval-deciders.ts` mirrors two Cerbos policies IN APPLICATION CODE,
  purely for notification routing (Cerbos remains the sole authorization authority; the mirror
  only decides who gets TOLD a high-risk action needs review — every decide/approve endpoint still
  calls `authorize()` at decide-time, unchanged). There was no automated check that the mirror
  still matches the policies it claims to reproduce. A policy edit that changed the decider role
  set with no matching edit to the mirror would silently misroute — or drop — that notification
  mail, with zero signal. Live risk at the time of this ticket: the concurrent D14 session had just
  changed `resource_automation_approval.yaml` (added `retry` alongside `decide`); its role set
  happened to be unchanged (verified by reading the file), but nothing would have caught it if it
  hadn't been.
- **The fix — a new file-parsing test, no live Cerbos, no DB.** `src/core/approval-deciders-policy-drift.test.ts`
  reads both policy YAMLs at test time and asserts each policy's decide-equivalent rule's
  `derivedRoles` matches the concrete role names the mirror's header documents:
  `resource_automation_approval.yaml`'s `decide` action → `company_admin`, `group_executive`,
  `hr_manager` (WSD-2's `module_manager`, composed for `module=="hr"` — the only concrete
  instantiation `resolveAutomationApprovalDeciders` ever queries); `resource_agency_approval.yaml`'s
  `approve` action (it has NO `decide` action at all) → `company_admin`, `agency_approver`
  (`module_approver`, composed for `module=="agency"` since `agency.controller.ts` always passes
  that module for `agency_approval` resources).
- **Narrow hand-written parser, not a new dependency.** `yaml`/`js-yaml` resolve in `node_modules`
  but only as TRANSITIVE deps (`npm ls yaml` shows neither declared in
  `platform-nest/package.json`), so depending on either would silently ride some OTHER package's
  dependency tree shape rather than a guarantee of this one. The test instead parses the two
  files' `rules:` list items itself — reads each item's inline `actions: [...]` /
  `derivedRoles: [...]` flow-sequences (the entirety of what both files use for these fields today)
  and THROWS rather than guessing if that shape ever changes. It never evaluates
  `condition.match.expr` (no CEL evaluator) — role NAMES only, the same granularity the mirror's
  own header comment uses. The `["*"]` platform_admin catch-all is deliberately excluded from the
  decide-equivalent match (a superadmin bypass, not a decider grant the mirror's header lists).
- **Verified NOT to false-positive on the exact live case.** One test simulates "before D14-06" by
  stripping `retry` from the real policy text in memory and confirms the resolved role set is
  identical with or without it — the guard reacts to ROLE changes, not action-list additions. A
  second test perturbs an unrelated comment near the rule for the same proof. Both prove the guard
  would NOT have fired on the D14-06 change that just happened.
- **Demonstrated failure, not just claimed — two proofs, neither touching the real policy files**
  (D14 owns them, read-only per the shared-tree boundary): (1) a committed test mutates an
  in-memory copy of the automation policy text to add an extra role (`manager`) to the `decide`
  rule and asserts the comparator throws with an actionable message naming the policy file, the
  added role, and that `approval-deciders.ts` must be updated; (2) manually confirmed with real red
  terminal output — temporarily dropped `hr_manager` from this test file's own expected-role
  constant, ran `npx vitest run src/core/approval-deciders-policy-drift.test.ts`, got **4/5
  failing** with the exact actionable message (`added role(s) [hr_manager] ... platform-nest/src/core/
  approval-deciders.ts (and its header comment) mirrors this policy ... MUST be updated to match,
  or the wrong people get told about — or nobody is told about — a medium-or-higher-risk action.`),
  then reverted the constant and re-ran green (5/5).
- **Verification, real output, no DB needed at all** (pure file-parsing — no `TEST_DB_PREFIX`
  required, nothing to drop from `gaiada-test-pg`): `npx vitest run
  src/core/approval-deciders-policy-drift.test.ts` → **5/5 green**. `npx tsc --noEmit` → clean.
- **No bug found today.** The concurrent D14 change kept the same `["company_admin",
  "group_executive"]` role set on the `decide`/`retry` rule — confirmed by reading the file at
  ticket start, and now continuously by this guard, which passes against the current policies +
  mirror.
- **Not touched, deliberately:** both Cerbos policy files (`resource_automation_approval.yaml`,
  `resource_agency_approval.yaml` — D14 owns them), `src/mail/**` and `src/db/**` + any new
  migration (a concurrent MAIL-10 session), `src/core/approval-execute*.ts`/
  `approval-executables*.ts`/`hub-client.ts`/`events/consumer.service.ts`/`mcp-hub/**` (D14),
  `ai-gateway-go/**`/`hermes-gateway/**` (the assistant session). This ticket is test-only: no
  migration, no production-code change, no Cerbos policy edit.

## webdev
### [0.12.0] — 2026-08-08 · IN PROGRESS
- **Maintenance Intake (MI-01..05) — schema/migrations DEV-VERIFIED, docs reconciled (MI-06):**
  Complete change-request intake surface landed (migration `0088_webdev_change_requests.sql`);
  portal submission + staff triage queue + conversion to pipeline runs or PM tasks. Five endpoints:
  `GET/POST /api/:t/portal/change-requests` + `GET /api/:t/portal/change-requests/:id` (client
  surface, viewer-permitted submission); `GET /api/:t/webdev/change-requests` (triage queue),
  `GET /api/:t/webdev/change-requests/:id` (detail + linked artifact status), `POST /api/:t/webdev/change-requests`
  (internal-source logging), `POST /api/:t/webdev/change-requests/:id/triage` (decline or convert).
  Cerbos resource `resource_webdev_change_request.yaml` + `request_change` action on
  `resource_portal.yaml`. UI: `(portal)/portal/requests` + `(app)/departments/[deptId]/requests`.
  Tested: portal surface 11/11, unit suite 1535/1535, `tsc` clean, `DEMO_MODE=1 npm run build` green.
  Triage gate (mini_run spawn or pm_task create) idempotent under concurrent tries (advisory lock +
  re-check `status='new'` in one transaction). D-2a: table takes CORE tenant wall (deliberate,
  no `app_module_allowed()`). F1: disposition audience follows authorship (portal requests notify
  contacts; internal requests don't). F2: D17 custom fields DEFERRED.
  `FRONTEND-BFF-CONTRACT.md` §16f documented the endpoints; module bumped 0.11.0 → 0.12.0.
  **Feature is IN PROGRESS until MI-07 (QA gate) passes.**

### [0.11.0] — 2026-08-03 · IN PROGRESS
- WD-20 Phase-1/Phase-2 close-out. Phase 2 (`webdev-integrations-console`) completed its own QA gate
  separately; see its evidence doc. Module version recorded for tracking; no schema changes this entry.

## webdesk
### [0.0.0] — 2026-07-23 · PLANNED
- Blueprint approved; no code. Phased plan P1–P6 (see BLUEPRINTS.md).
- **2026-08-04 — blueprint amended to v1.1 (still no code, version unchanged):** C-03 unpinned from
  Hostinger SMTP → rented relay (Brevo free tier → ZeptoMail/SES at volume); three sending
  subdomains with separate per-stream provider keys (new decision D14 — form abuse must never burn
  login mail's reputation); default identity `From:` our domain + `Reply-To:` the human, per-tenant
  "send as your own domain" as an SPF/DKIM opt-in upgrade; explicit statement that **Zone A (ERP)
  mail does not route through C-03** (platform-nest carries its own mail module — see the `mail`
  module above); C-02 annotated that per-tenant recipient addresses are plain config (no DNS or
  mailbox work on our side); portability table Mail row updated. HTML is v1.1; **PDF + hosted
  artifact not re-rendered yet** (see BLUEPRINTS.md regeneration note).

## search-marketing
### [0.5.0] — 2026-08-01 · DEV-VERIFIED
- **Promoted `IN PROGRESS` → `DEV-VERIFIED`** by the SM-24 final QA gate (tracker §6bu, re-verdict
  §6by) after SM-19/20/21/22/25c/63–75 all landed with their own gates discharged.
- **One dev-provable defect found and closed in this window:** `main.ts` wired
  `registerLiveAdsExecutor`/`assertAdsWriteModeBootSafe` inside only the `SEARCH_PROVIDER_MODE=live`
  branch (a stale comment claimed the registration ran "unconditionally"), so `simulate`-data +
  `live`-ad-writes booted silently and would have failed at request time, after an approval had
  already been spent — reproducible with two env vars, no vendor account. Fixed by hoisting both
  calls to function scope outside the mode branch (§6bv) and made test-executable via an extracted
  `wireSearchProviderModeAndAdsWriteMode()` that `bootstrap()` calls (SM-75, §6bx), so a boot-wiring
  smoke test drives the real production call site instead of a copy of its ordering. The QA gate
  independently re-derived the negative control (re-nesting the calls) and reproduced the exact
  2-of-5-red symptom before restoring via `sha256sum`-verified `cp` (§6by).
- **A related infra fail-open, found and fixed in the same window:** `docker-compose.vps.yml` had no
  environment passthrough for `GOOGLE_OAUTH_*`, `GOOGLE_ADS_*`, or either callback secret — real
  credentials set in `infra/compose/.env` would have had zero effect on the container while the
  platform reported the vendor "not configured" (indistinguishable from a deliberate choice not to
  configure it). Both `docker-compose.vps.yml` and `.env.example` fixed (§6bw).
- Local stack brought to latest (image rebuilt, DB migration head `0061 → 0069`) and re-verified:
  `src/modules/search` **1061 passed / 4 skipped, zero reds**; full platform tree **2552 passed /
  4 skipped, zero FAIL markers**, identical count pre/post-migration (§6bw/§6bx.1).
- Real-vendor-account fidelity (Google OAuth client, Ads developer token, DataForSEO/Semrush/Ahrefs
  keys) remains deliberately unproven — staging-only per standing policy (SM-41G) — and is not a
  condition of `DEV-VERIFIED`, which measures dev-stack end-to-end exercise, not production
  readiness.

### [0.1.0] — 2026-07-23 · IN PROGRESS
- **SM-01 landed** (migrations `0034_module_search.sql` + `0035_integration_connections_search_providers.sql`
  + `module-search-rls.test.ts`): 18 `search_*` tenant tables under third-wall FORCE-RLS + the no-RLS
  `search_data_cache` (D-4), dual-mode embedding col (float8[] fallback — pgvector absent, OQ-8),
  additive `integration_connections` widen. Merge gate cleared: QA PASS (45/45 db tests, adversarial
  RLS matrix on a second DB) + architect APPROVE-WITH-NOTES (full §04/§11 conformance).
- **SM-02 landed** (`src/modules/search/` — ModuleContract, controller `api/:t/modules/search`, 18
  `search.*` mcpTools, property/engagement/kpi CRUD, `engagements/:id/scope` + preset seeding,
  service-layer same-tenant FK validation). Full repo suite 512/512 green; tsc + withTenants lint clean.
  Module is fail-closed until SM-03 adds Cerbos policy (by design).
- **SM-03 landed** (`cerbos/policies/resource_search_{property,engagement,keyword,audit,campaign,report,
  ledger}.yaml` + derived-roles wiring + `search-cerbos.test.ts` + the `platform-ui/src/lib/rbac.ts`
  capability mirror with `search_staff`/`search_manager` derived roles). **Declared 2026-07-27 after
  verification** — the code landed 2026-07-24 but the gate was never recorded. Re-run against live
  Cerbos (49 executable policies): 25/25 parity tests green, covering owner/manager/member/served-dept
  plus every deny case in the AC (`launch`/`apply_manual`/`apply_negatives`/`set_budget` denied to staff
  and to served-dept staff, `approve`/`deliver` denied to member, `set_scope` denied to member per D-11,
  ledger `admin` denied to member, cross-tenant grants denied, low-assurance principals get nothing).
- **SM-00 (reconcile, off-design ticket) 2026-07-27:** all four search suites re-run against live
  Postgres + Cerbos → **60/60 green** (`search.test.ts` 13, `search-cerbos.test.ts` 25,
  `module-search-rls.test.ts` 15, `scope-presets.test.ts` 7). MODULES.md section header corrected
  (`0.0.0 · PLANNED` → `0.1.0 · IN PROGRESS`, matching the registry row it contradicted); execution
  tracker added at `blueprints/seo-sem-execution-tracker.md`.
- **SM-04 AC discharged 2026-07-27 (awaiting the ⚡ QA + architect gate).** The provider layer
  (`providers/{types,registry,dispatch,cache,ledger,mock-provider}.ts`, landed 07-24) gained its
  missing halves: **`providers/dispatch.test.ts` (35 tests)** and the **`GET
  engagements/:id/cost-projection`** endpoint (+3 controller tests, with `?toolScope=` what-if
  pricing and an `overBudget` flag). All five AC clauses proven on live PG — scope-disabled refused
  naming the *toggle*, cache hit = cost 0 (incl. the cross-tenant D-4 reuse that IS the cost model),
  8 concurrent identical queries → exactly 1 dispatch, engagement+tenant breach refuses/emits/blocks,
  ledger sums reconcile with the stop-loss's own reader. Plus true-up (same row, never a second),
  rollback-on-provider-failure, and fail-closed provider resolution. Search suites **98/98**; tsc and
  `lint:withtenants` clean. Three findings fixed: (1) a scope refusal could be masked by
  `unknown_provider` when no driver is registered; (2) `lint:withtenants` was **failing** on
  `ledger.ts:70` — SM-04 had landed without that gate, now a reasoned allowlist entry **pending
  architect ratification**; (3) the 80%-warn float boundary documented. Full-repo suite: 574 passed /
  1 failed / 60 skipped — the one failure is `admin/bot-admin.test.ts` (WhatsApp chat-thread proxy),
  reproducible, pre-existing and unrelated to search.
- **SM-05 + SM-06 AC discharged 2026-07-27 (awaiting the same ⚡ gate).** `providers/dataforseo.ts` —
  the real driver behind SM-04's interface (Standard-queue `task_post`→`task_get` with the 40602
  in-queue poll, keyword metrics, backlinks, AI-visibility, §8a rate table) with **25 mock-server
  tests** on an injected `fetchImpl`: no network, no credentials, no deposit needed. Live queue exists
  but only via an exact `live` string — a typo cannot triple the bill. Config: `config.search.
  {dataforseo,pillars}`, keyless bootstrap registration in `main.ts`, and env rows in
  `platform-nest/.env.example`, `infra/compose/.env.example` and `docker-compose.vps.yml`.
  **Keyless is first-class** — no credentials means the paid driver is never registered, paid
  capabilities fail closed, and the $0 pillars keep working. Added beyond the ticket text: the
  per-pillar kill switches needed somewhere to bite, so dispatch gained a **gate (-1)**
  (`PillarDisabledError`) ahead of the scope gate. Search suites **125/125**; tsc + lint clean.
  **Still gated on the $50 deposit:** the real-data pull (SM-05's one remaining AC clause).
- **M1 reached pending the gate** — the money path is fail-closed at four independent gates
  (pillar → engagement tool-scope → ordered budget stop-loss → provider capability).
- **Next:** the ⚡ QA + architect gate over the P0 tail, then P1 (SM-07 crawl workers ∥ SM-09 keywords).

### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.1 architect design ratified; no code. See
  `blueprints/seo-sem-foundation.md` + `blueprints/seo-sem-design.md`.
- Owner decisions locked: dept name SEO (3-craft-group Web-Dev console), dual-mode SEM execution,
  no-RLS shared market-data cache, per-engagement tool-scope config.
- 26 tickets P0–P3 + 2 committed P4 (design §12).

## social-media
### [0.5.19] — 2026-08-23 · IN PROGRESS
- **Two SECURITY-SHAPED follow-ups closed, both named honestly by earlier seats rather than silently
  absorbed.** Full evidence in `docs/modules/MODULES.md`'s own 0.5.19 entry and
  `docs/plans/smm-tracker.md`'s evidence blocks.
- **A — OAuth state single-use.** New `social_oauth_states` table
  (`migrations/202608221751_social_oauth_states.sql`, third RLS wall) + new shared
  `publisher/oauth-state.ts` (mint/parse/consume, atomic `UPDATE...WHERE consumed_at IS NULL`)
  replace LinkedIn's/YouTube's per-network signed-but-replayable state. RED (pre-fix): the same
  signed state verified successfully on repeat presentation. GREEN: a replayed/consumed/
  network-mismatched state is refused with a typed `SocialOAuthStateError`, never a generic 500.
  Found+fixed in the same pass: `YouTubeOAuthStateError` was never registered in `main.ts`'s filter
  list (a body-less 500 on any bad YouTube callback state) — closed by construction by consolidating
  both networks onto one error class.
- **B — SMM-22's Cerbos gap for an agent/automation-origin metered-tool re-drive.** Live-probed as
  ALREADY denied before any policy edit (absence from `resource_mcp_tool.yaml`'s executable-tool
  bracket already refuses `social.publishPostMetered` for an unattended caller, grant or no grant) —
  closed as documentation + regression-test hardening of a correct-but-untested-and-undocumented
  invariant, not a live hole (stated plainly, per instruction not to invent work). Dated SMM-22 block
  added to the policy file; five new LIVE-Cerbos tests in `mcp-hub/src/cerbos.test.ts` pin the DENY
  for both n8n/automation and agent-origin callers, with and without a verified grant.
- Tests: platform-nest social suite **531/531** (5 pre-existing, unrelated skips), mcp-hub **273/273**,
  `tsc --noEmit` clean in both. Cerbos policy compiled clean before and after
  (`ghcr.io/cerbos/cerbos:0.54.0 compile`).

### [0.5.14] — 2026-08-21 · IN PROGRESS
- **SMM-17 — the inbox reply flow: draft → WS4 → send, its own D14 registry entry, built by reusing
  SMM-09's pattern rather than reinventing it.** No migration — 0105's own `social_inbox_messages`
  schema (`direction`/`status`/`approval_id`/`args_sha256`/`external_id`, the
  `sim_sent_reply_has_approval` CHECK) already anticipated this flow; the one new dial is
  `tool_scope.inbox.reply` (jsonb, additive). New `reply-precondition.ts` (own `REPLY_REFUSAL`
  vocabulary, four stages `scope → hash → unconsumed → retention`) and `reply-dispatch.ts` (the
  transactional stamp, mirroring `dispatch.ts`). `core/approval-executables.ts` registers
  `social.sendReply` with **`neverAutoRetry: true`** — a reply is an outbound public write whose
  landed-or-not is unobservable in the ambiguous window, the same property that makes publish opt out.
- **Retention, answered:** a draft reply that quotes/embeds the comment it answers inherits
  LinkedIn's 48h cap; the precondition's `retention` stage fails closed (`source_content_purged`) the
  instant the thread's `activity_content_purged_at` is set — reusing the EXISTING column SMM-36's
  purger maintains, no new column, no second job.
- **A real defect found and fixed in SMM-36's purger**: its two per-message purge UPDATEs matched ANY
  message row with no `direction` filter — correct while every row was inbound, wrong now that
  outbound reply rows share the table. Fixed with `m.direction = 'in'` on both UPDATEs.
- Five new endpoints (create/edit/approve draft, dry-run, send) + list, all under
  `/api/:tenantId/modules/social/threads/:threadId/messages*`; five new MCP tools. Cerbos split
  matches `resource_social_inbox.yaml`'s own documented `assign` (drafting) vs `reply` (sending).
- **559 / 0 / 5** across the SMM-16 baseline's own four-file set (**522 / 0 / 5**; +37 new, exact
  arithmetic, cross-checked by two independent runs). `tsc` clean; all four migration/withTenants
  linters green (no migration). `cerbos/policies/resource_mcp_tool.yaml`'s executable-tool list gets
  `social.sendReply` alongside `social.publishPost` (D14-13's both-halves-move-together doctrine).

### [0.5.13] — 2026-08-21 · IN PROGRESS
- **SMM-16 — AI triage over the engagement inbox: sentiment/category/urgency classification, spike
  detection, SLA guard flows.** New migration `202608211200_social_inbox_triage.sql` (category/
  urgency/ai_triage_status/ai_triage_at/sla_alerted_at on `social_inbox_threads`; a structural CHECK
  makes `unclassified`/`unavailable`/`classified`/`purged` mutually exclusive — never a nullable
  column conflating "never asked" with "asked, got nothing usable"). New `inbox-triage-job.ts`
  (`smm-inbox-triage` + `smm-inbox-sla-guard`). `ai-drafts.ts`'s new `parseTriageDraft` has NO
  deterministic fallback — a classification is a guess, never laundered into a fact.
- **The cross-client leak test.** No WS8 retrieval step exists on this surface (unlike SMM-19/23), so
  the leak boundary is "one gateway call, one thread's own messages" — proven by classifying two
  clients' threads in one sweep and asserting each prompt only ever contains its own thread's text.
- **Retention: a text-derived label inherits LinkedIn's 48h cap on the SAME clock.** Wired into
  SMM-36's existing purger (`inbox-retention-job.ts`), never a second job — the same UPDATE that
  scrubs the excerpt now also nulls sentiment/category/urgency and flips the status to `purged`.
- **SLA guard reuses 0105's existing `sla_due_at`/`ix_social_inbox_threads_sla`**, sourcing its
  target ONLY from `social_engagements.tool_scope.inbox.slaMinutes` — never an invented duration.
  Spike detection is config-driven with its rationale in `config.ts` (no live traffic exists to
  measure a baseline from, per D-23) — never a constant presented as measured.
- Two new event handlers (`social.inbox.sla_breached` risk-shaped bell+mail,
  `social.inbox.spike_detected` bell only), riding the already-drained `social_post_variant` stream.

### [0.5.7] — 2026-08-20 · IN PROGRESS
- **SMM-23 — client-facing engagement reports: snapshot + AI narrative → approve → render → files +
  Drive + deliverable.** `social_reports` (0105) + its Cerbos policy/catalog rows (0106) already
  existed from SMM-30's forward-looking seed; this ticket is the first handler. No migration, no
  Cerbos change. New `social-reports.ts` (pure snapshot/document builder) +
  `social-reports.controller.ts` (own controller class, same route prefix as `SocialController`).
  - **No invented numbers**, reading SMM-21's `social_metrics_daily`/`social_post_metrics`: a metric
    never pulled for the period is OMITTED from the frozen KPI array, never rendered as `0`; a real
    own-row count (posts published) is the one legitimate real zero.
  - **Narrative rides SMM-19's gateway path** (`ai-drafts.ts`'s new
    `buildReportNarrativePrompt`/`parseReportNarrativeDraft`, fail-soft): the prompt hands the model
    ONLY the already-filtered real numbers; a gateway failure falls back to a deterministic
    template built from the same numbers. **The cross-client leak test** (`social-reports.test.ts`)
    proves a report's narrative is grounded ONLY in its own engagement's client corpus, never the
    other client's, in both directions — same fake-WS8-server technique SMM-19's own test uses.
  - **Approval reuses neither existing surface** — not SMM-09's D14 registry (nothing here
    executes on approval) and not SMM-31's client-review stage (different resource, different
    audience) — but the in-console module-permission approval `smm-design.md` §07 specifies for
    low-impact artifacts, mirroring `search_report`'s own `draft → in_review → approved →
    delivered` state law.
  - **Render reuses TR-21's report-renderer sidecar** (`mintPrintJobToken`/`renderPdfViaSidecar`) —
    no second renderer. `header.grain` is pinned to `"company"` (no fifth "client engagement" grain
    exists; adding one is out of this ticket's file surface), so the print page's per-grain chart
    composition doesn't render this document's own series/tables today — a named limitation, not a
    silent gap. Proven with a REAL sidecar round trip (a stand-in server that itself fetches the
    real internal print-payload route), not a mocked call.
  - 6 new MCP tools (`social.draftReport`/`listReports`/`getReport`/`editReport`/`approveReport`/
    `deliverReport`; `deliverReport` is `impact:'medium'` — outward-facing and unretractable, the
    same ratified ground `search.deliverReport` uses), 5 new `social.report.*` permissions declared
    on the module contract (already-catalogued; `delete` stays undeclared, no endpoint yet).
  - Test counts **370/0/0** (baseline 365/0/0, +5). `tsc --noEmit` clean. IAM/bundle alignment
    suites green, unaffected (no catalog/Cerbos change). Full detail: `MODULES.md`'s social-media
    `0.5.7` entry + `docs/plans/smm-tracker.md`'s SMM-23 evidence block.

### [0.4.0] — 2026-08-13 · IN PROGRESS
- **SMM-19 — brand-voice RAG + AI drafting, DEV-VERIFIED against live Postgres + Cerbos-stubbed
  HTTP.** Three new endpoints, all through `ai-gateway-go` (zero direct vendor calls — asserted
  directly, see below), all writing DRAFT rows only, never dispatching:
  - `POST engagements/:id/brand-corpus/ingest` — approved past posts + brand guidelines become
    tenant+client-ACL'd WS8 knowledge sources (`social-brand:{tenantId}:{clientId}`, design D-13).
    `social_brand_profiles.knowledge_source_ids` stores the pointer only — never corpus text, never
    an embedding column; no new migration needed for this ticket.
  - `POST posts/:postId/variants/:variantId/draft-caption` — caption + hashtags grounded in the
    client's own corpus (Hermes by default, Claude only as a `provider` reorder hint when
    `tool_scope.ai.cloudPolish` is on). Hashtags are re-derived through `applyHashtagStrategy()`
    every time — the brand's `hashtag_strategy` and the network's own cap
    (`media-rules.ts`'s `maxHashtagsFor`/`supportsFirstCommentFor`, REUSED not duplicated) both
    apply regardless of what the model proposed. Persists through the SAME state law
    `updateVariant` enforces (re-validate, recompute `args_sha256`, invalidate any existing
    approval in one statement).
  - `POST posts/draft-ideas` — N content-idea posts (`status='idea', source='ai'`), idempotent via
    a caller-supplied `ids` array.
  - **The cross-client leak test** (`social-ai-drafts.test.ts`): a fake WS8 server reimplementing
    the real `scope = ANY(acl)` isolation predicate over a store holding BOTH clients' corpora
    proves a draft for client A's variant retrieves and quotes ONLY client A's excerpts — never
    client B's — in both directions. The scope is derived from the DB-joined `client_id`, never a
    request field.
  - `ai.drafting` off refuses `ai_drafting_disabled`; a `wantImage` request refuses
    `image_generation_unavailable` — both before any gateway egress (D-17: no image-generation
    backend exists, and none is built here).
  - 3 new MCP tools (`social.ingestBrandCorpus`, `social.draftPostVariant`, `social.draftPostIdeas`),
    `write:true, impact:'low'`, reusing the EXISTING `social.engagement.update`/`social.post.update`/
    `social.post.create` permissions — no new catalog/Cerbos change in this ticket.
  - 59 new tests (22 unit + 5 gateway-host-isolation + 10 golden-case incl. the leak test); social
    module suite **87/87 passing**. `FRONTEND-BFF-CONTRACT.md` §19 extended.

### [0.0.0] — 2026-07-23 · PLANNED
- Foundation research + v1.0 architect design; no code. See `blueprints/smm-foundation.md` +
  `blueprints/smm-design.md` (+ print `GAIADA-Social-Media-Engineering-Blueprint.pdf`).
- Decisions locked: scope v1 = organic publish + engagement + copy + assets (paid/listening/influencer
  parked); publisher = Postiz (AGPL-3.0) run AGPL-CONTAINED (Mixpost Pro paid fallback); Chatwoot dropped
  (engagement uses Postiz's comment/collab surface). Module key `social`, tables `social_*`; mandatory
  human-in-the-loop (one-shot payload-hash approvalId, no auto-publish); one usage ledger (X fees + gen
  credits); no shared no-RLS cache.
- **Next:** P0 contracts + AGPL-containment spike (SMM-01 migrations/RLS → SMM-02 module/contract →
  SMM-03 Cerbos → SMM-04 Postiz adapter/containment → SMM-05 tenant mapping → SMM-09 approve-execute).
  27 tickets P0–P4 + 2 decision-gated (design §12).

## creative
### [0.1.0] — 2026-07-23 · PROTOTYPED
- Baseline (pre-existing dev code): **Image Studio** client-side grading engine (WebGL2 LUT + Canvas2D
  fallback, pure imaging lib, 35 UI tests, visually verified) + `creative_assets` persistence (migrations
  `0031`/`0032`, `/api/:t/creative/assets`) + grading-trainer ONNX scaffold. See memory `creative-image-studio`.
- **Expansion designed (no code yet):** v1.0 architect design authored — `blueprints/creative-foundation.md`
  (research + Magnific head-to-head) + `blueprints/creative-design.md` (§00–§14) + print
  `GAIADA-Creative-Engineering-Blueprint.pdf`. Module key `creative`, tables `creative_*`, third-wall RLS,
  migration `0036`; `creative_assets` extended in place + versions/collections/brand-kits/render-jobs/
  usage-ledger/scopes. Build-light DAM (RLS store + Shared Drive + pgvector CLIP search + BLIP tags +
  imgproxy renditions). Default model stack commercial-license-CLEAN; SUPIR/FLUX-dev/RMBG/IC-Light-V2/SVD
  quarantined behind license gates.
- Owner decisions locked (2026-07-23): serverless-GPU-first · hybrid image licensing (clean default + FLUX
  paid opt-in) · hybrid video (Wan 2.2 OSS + Veo/Kling API budget) · build-light DAM.
- **Next:** Phase 0 clarity-upscaler Replicate spike (kill Magnific now) → P0 contracts → P1 upscale via
  the Render Gateway → P2 gen/edit → P3 DAM → P4 video. 27 tickets CR-00–CR-26 (design §12); Opus-flagged
  CR-01/06/13; QA gates CR-01/06/12/13/20.

## mail (continued)
### [0.0.20] — 2026-08-06 · IN PROGRESS · MAIL-31 (senior-be) — the replay verifier now measures what it claims

The audit table originally scoped here was **dropped**: the owner decided to stand up Tier-2 Loki, which
makes the existing `logMagicLinkAudit` stdout lines durable and searchable — the same address, IP,
outcome and timestamp the table would have stored. Building both would duplicate the facts and add a
migration plus a prune mechanism for nothing. Nothing was written before the redirect; `migrations/`
untouched at `0084`.

What shipped is the verifier fix, which stands on its own:

- **The false negative:** `replay-inbound.mjs` proved threading via one *aggregate* `mail_messages`
  delta across a whole corpus run for a single reply token. Fixture `06-replayed-provider-id` is the
  only one with a **fixed** `provider_message_id` (no `{{RUN}}` nonce) — deliberately, since its point
  is that a second delivery lands zero rows. When 06 was the only token-referencing fixture in a run
  and its id had already landed, the delta was *correctly* 0, and the script printed
  `THREADING BROKEN` over correct behaviour.
- **Why that mattered:** it is the exact mirror of the defect this thread began with, where the same
  script reported `PASS` over a completely dead path (MAIL-29). Both are checks that do not measure
  what they claim — one blind to failure, one blind to success.
- **The fix** adds a dedicated per-message check for the duplicate fixture, independent of the
  aggregate: query by `(provider, provider_message_id)` to prove a row genuinely exists (catching
  "nothing landed"), then redeliver the identical payload and re-query to prove no second row appears
  and the response is still 204 (catching "dedup itself is broken"). **Neither leg alone distinguishes
  broken from correct; both are required.** Also extracted `signedHeaders()` so the redelivery is
  freshly signed — a reused signature would fall outside `MAIL_INBOUND_SIGNATURE_TOLERANCE_S`.
- **MAIL-29's aggregate check is untouched in strength** — it still governs every non-duplicate
  fixture, and it still fires in the negative demonstration.
- **Proven both directions with real ingredients.** New permanent `replay-inbound-mail31.e2e.test.ts`
  boots a real listening NestJS instance against the disposable test Postgres and shells out to the
  actual script. Negative direction was demonstrated by editing `intake.ts`'s INSERT to
  `SELECT ... WHERE false` — a genuine zero-row write rather than a faked return value — clearing the
  transform cache and re-running fresh: both `THREADING BROKEN` and the new dedup failure fired, exit 1.
  Reverted, `git diff` byte-identical, harness green again.
- Evidence: `src/mail` **177/177 across 22 files**; `tsc` clean; both lints OK; `rls.test.ts` unmodified
  and green; `mail24-timing-remeasure` ratio **1.27** (inside the 1.8 bound), confirming nothing here
  regressed the enumeration property.

### [0.0.18] — 2026-08-06 · IN PROGRESS · MAIL-29 (senior-be) — inbound threading was dead in production, and the corpus could not have known

- **The bug:** `extractAngleAddress()` in `inbound/brevo-payload.ts` lowercased the *entire* recipient
  address, including the local part carrying the VERP token. Tokens are minted mixed-case base64url
  (`randomBytes(16).toString("base64url")`) and matched with case-sensitive `=` against
  `mail_log.reply_token`, so any token with an uppercase character could never match. Confirmed dead
  live: all 18 fixtures replayed against the deployed box left `mail_messages` at **0**.
- **Fixed** by splitting on the last `@` and lowercasing only the domain — which is also the correct
  email semantics (domain case-insensitive, local part case-sensitive), so the original code was wrong
  on both counts. Matching stays deliberately **exact-case**: folding case on the stored token would
  merge each letter's two base64url symbols, costing ≈0.81 bits/char — roughly **17 bits off a
  128-bit token** whose entire job is to be unguessable.
- **Why every test passed over a dead path — the more useful finding.** `corpus.test.ts`'s
  `seedMail()` minted tokens as `tok` + `newId()` hex: lowercase UUIDv7, lowercase prefix. **Every
  token the corpus ever exercised was all-lowercase by construction**, so the blanket-lowercasing was a
  no-op for all of them. The DB-level "threads onto the right entity" assertions were genuine and
  correct; they never got to see the one input class that broke production. The defect was that the
  **harness generated its match keys from a different alphabet than production**.
- **Closed at source, not patched around:** `seedMail` now mints tokens exactly as `queue.ts` does and
  forces mixed case, so cases 01/02/03/06/08–18 all exercise the path — not just one new test. Added
  `[MAIL-29]` pinning the literal incident token. Proven both directions by temporarily reverting the
  fix in-file (not via git, per shared-tree discipline): **21 of 26 failed**, including the exact
  zero-rows symptom; reapplied, green again.
- **The verification gap closed too:** unmatched returns `204` by design (A9, so it is not a token
  oracle), and `replay-inbound.mjs` asserted only HTTP status — a completely broken path reported all
  PASS. It now takes `--database-url`, snapshots `mail_messages` before/after, and **fails the run**
  with `THREADING BROKEN` if nothing landed.
- Evidence: `src/mail` **175/175 across 21 files**; corpus 26/26; `tsc`, `lint:migration-rls`,
  `lint:withtenants`, A12 grep gate all clean; no migration; **0 orphan databases** — INFRA-01's
  teardown fix working in practice.
- **Caps at IN PROGRESS.** A live-box `replay-inbound.mjs` run against a real reply token is the
  remaining step. Ops follow-up, out of scope: any inbound reply received before today carrying a
  mixed-case token was silently dropped and is unrecoverable.

### [0.0.17] — 2026-08-06 · IN PROGRESS · MAIL-24/25/26 + a repair of this file's own bookkeeping

> **Why this entry jumps to 0.0.17 and consolidates three tickets.** `MODULES.md` claimed
> `mail 0.0.15` in its registry row and carried a `0.0.16` detail block for MAIL-25, while this
> file's mail section stopped at `[0.0.14]` — so two versions were asserted with no changelog
> entry, violating versioning rule 1. Cause: four agents and three other sessions appended to
> these two files concurrently and clobbered each other's writes. Rather than silently renumber,
> the gap is recorded and the registry is moved to `0.0.17`. Mitigation now in force: subagents are
> **forbidden** from editing `MODULES.md`/`CHANGELOG.md` and report their text instead, so a single
> writer applies it — these are the highest-contention files in the repo.

- **MAIL-24 (senior-be) — closed three findings from MAIL-11's adversarial gate.**
  (1) The **timing enumeration oracle**: measured at 3.25× (known 13ms / unknown 4ms, tight IQRs
  both sides, so signal not noise) and closed to **1.28×** by giving the unknown branch
  equivalent *real* work — a decoy insert/delete rolled back through `withMailContext` — rather
  than sleeps, which are themselves fingerprintable and tax every caller. Unknown now runs
  marginally *slower* than known, which is the safe direction.
  (2) **`x-forwarded-for` spoofing** defeated the per-IP rate limit outright (8 spoofed IPs, 8
  successes). Now gated behind a trusted-proxy allowlist defaulting to **trust nothing**. Not
  exploitable before the fix — no browser-facing request form exists — but it would have become
  exploitable the day one shipped.
  (3) A **failed auth-stream send was silent and unretried**. Kept single-attempt by design
  (retrying would require persisting a raw token, which M10 deliberately never does) and made
  loud via a `MailAuthStreamSendFailed` alert instead. A bounded re-mint path was considered and
  deliberately **not** built — it carries its own replay/enumeration surface and belongs to an
  architect call once the alert shows real failure frequency.

- **MAIL-25 (senior-be) — inbound truncation notice: an accident replaced by a guarantee.**
  Migration **`0082_mail_truncation_metadata.sql`** (additive `body_truncated` /
  `body_truncated_chars`, zero backfill DML) plus the field on `ThreadMessageView`. Previously the
  notice rendered correctly *only* because the genuine elision marker happened not to sit on a
  quote-prefixed line — and a sender can forge that marker string (MAIL-19's corpus case 18 proves
  forged markers are stored verbatim, which is correct intake behaviour). The UI now renders from
  the structured columns, derived from the cap's own arithmetic, so forged markers stay inert plain
  text. The quote-prefixed-marker case that would have broken the old behaviour is pinned
  explicitly. Shipped as `0082`, not `0081`: a concurrent HR-loans session landed
  `0081_hr_loans.sql` mid-ticket, so this file was renamed — the **fifth** ledger movement in one
  session.

- **MAIL-26 (senior-be) — the two blind magic-link branches are now detectable.** MAIL-11 judged
  the audit trail *"adequate for the branches that write a DB row, not for the two that don't"* —
  a rate-limited mint and a rejected consume wrote nothing, leaving brute-force probing traceless
  beyond container stdout retention. Added fail-soft counters
  `mail_magic_link_rate_limited_total{dimension}` and
  `mail_magic_link_consume_rejected_total{reason}` (`unknown`/`expired`/`replayed`), plus two
  sustained-rate alerts (`>10` in 15m for 5m — rate-based, since occasional blocks are normal).
  **No migration**, deliberately: the ledger had already moved five times and more sessions were
  starting. The interesting part is how the `reason` label avoids creating a *new* oracle — the
  single-use `UPDATE … RETURNING` became one statement with a **sibling CTE** reading the
  pre-update snapshot, so classifying why a token was rejected costs exactly the same as not
  classifying, with no second query gated on the first. Verified unregressed: the HTTP response
  stays byte-identical across all three rejection classes, and MAIL-24's timing bound still holds
  (re-measured 1.11× and 1.56×, both under 1.8). **Counters existing is not alerts firing** —
  WS9/Loki is not running, and per-attempt forensics (which address, which IP) still needs log
  aggregation. This narrows the blind spot to "a sustained run is happening"; it does not close it.

- **MAIL-27 (qa) — investigated the intermittent `[09-too-many-attachments]` CI flake and hardened
  the corpus against misdiagnosis.** The failure reddened `main` on an *assistant* commit, which is
  actively misleading during multi-session work. **Could not reproduce** — 40+ consecutive local runs,
  zero failures — and ruled out each candidate mechanism with evidence rather than assumption:
  attachment processing is a strictly sequential index-preserving `for` loop (no `Promise.all`), the
  read has `ORDER BY`, `fileParallelism: false` with no `.concurrent`, the rate limiter is reset in
  `beforeEach`, the scanner is off for this case so `scanStatus` is assigned synchronously, rows are
  re-seeded and tables truncated per test, and the controller awaits both transactions before
  returning so there is no visible-read race. Presumed a runner-level resource flake, not a logic
  defect — recorded as such rather than "fixed" by loosening an assertion.
  One **real latent fragility** was found and closed in 9 cases (09, 11, 12, 14–18, `[scan]`): they
  indexed `(await messagesFor(...))[0]` without first asserting the row exists, so an absent row
  throws an opaque `TypeError` instead of a named assertion failure — indistinguishable from a real
  assertion failure when skimming a CI log, and plausibly why this flake read as inscrutable. The
  guard is strictly additive; every protected property still holds (total-cap refusal, drop-but-still-
  thread, and `rejected`/`rejectReason` visibility per the §7.6 rider). Test-only, no version bump.
  Sibling cases 06/08/13 already had the guard.

Evidence: `src/mail` 174 tests green across 21 files with QA's `qa-mail11-adversarial.test.ts`
assertions intact; `promtool check rules` SUCCESS on 14 rules; `tsc --noEmit` clean;
`lint:migration-rls` (83 migrations) and `lint:withtenants` (272 files) both OK; A12 grep gate
zero matches. Test databases created under scoped prefixes and dropped, counts reconciled exactly.

### [0.0.14] — 2026-08-05 · IN PROGRESS · MAIL-10 (senior-be) — magic links (low-risk convenience login, design §9; M8/M11 locked)

- **Migration `0080_auth_magic_links.sql`.** Ledger re-verified with `ls migrations | sort | tail`
  immediately before writing DDL, per README rule 5 — `0077`/`0078`/`0079` taken (mail core, D14
  execution, module assistant), `0080` free. `auth_magic_links` is **GLOBAL — no `tenant_id`
  column, deliberately.** A magic link authenticates AS a user before any tenant is selected, the
  same shape as `mail_log`'s own NULL-tenant auth-mail rows; there is no precedent anywhere in
  this codebase for inventing a tenant attribution for a pre-tenant-context event, and doing so
  would have been exactly the kind of guess this ticket's brief says to avoid. Accessed via
  `withGlobal`, same class as `users`/`identity_links` — NOT one of the three `app.mail_context`
  GUC-gated tables from `0077` (that GUC answers "did the caller opt into MAIL context"; this is
  an AUTH-TOKEN table, a different boundary). **RLS invariant:** because this table carries no
  `tenant_id`, `src/db/rls.test.ts`'s "every tenant-scoped table has FORCE RLS" invariant does not
  select it at all — proven by running the suite **unmodified**, still 5/5 green. If a future
  change ever adds a `tenant_id` here, the migration comment states explicitly that it MUST also
  add FORCE RLS + a GUC-gated policy in the same change (the `0015`/MAIL-22 pattern) — this is the
  ticket's "do not repeat MAIL-22's mistake" instruction, written down at the point of risk.

- **The hard line: no usable token ever persisted, anywhere — including `mail_log.payload`.**
  `auth_magic_links.token_hash` stores `sha256(rawToken)` hex only. The subtler half of this: the
  rest of `src/mail/` defers rendering to the async sender worker, which re-renders
  `{subject,html,text}` from `(template_key, payload)` possibly seconds later — safe for approval
  mail (its `href` carries no secret) but NOT safe for a magic link, whose `href` **is** the
  secret; persisting it in `mail_log.payload` would put a live, admin-readable, backup-included
  login credential in the database, which is exactly what "store only hashes, never a usable
  token, never in a log line" forbids. Resolved by rendering + sending **inline** at mint time
  (the raw token lives only in a function-local closure inside `service.ts`'s `mintAndSend`/
  `sendNow` — nothing that reaches a `JSON.stringify` or `c.query` call ever sees it) and writing
  a **redacted** `mail_log` audit row (`payload: {ttlMinutes}`, no href, no token) that starts at
  `status='sending'` so the standard `WHERE status='queued'` sender-loop claim can never pick it up
  and try to reconstruct a mail from a hash it cannot reverse. The send itself is fire-and-forget
  from the caller — awaiting a real SMTP round-trip inside the HTTP handler would reopen the exact
  timing oracle the next bullet exists to close. Trade-off stated plainly: no retry/backoff on a
  transient send failure for this one template; acceptable because a failed magic-link send is
  cheaply recoverable (ask for a new one, rate limits permitting) and the alternative reopens an
  account-takeover-class timing leak.

- **`POST /auth/magic-link` — always 202, body AND timing flattened.** The handler never awaits
  the network send; the "unknown address" and "rate-limited" branches perform comparable DB
  round-trip work (`dummyEquivalentWork()`, three no-op queries approximating the real branch's
  suppression-check + two inserts) rather than short-circuiting — best-effort, documented as such
  (network jitter dominates any microsecond gap over real HTTP; this closes the gross
  application-level oracle, not a cryptographic constant-time guarantee). Rate limits — 3/address/
  hour, 10/IP/hour (`MAIL_MAGIC_LINK_RATE_PER_ADDRESS_HOUR`/`_IP_HOUR`, new fixed-window in-process
  limiter in `src/mail/magic-link/rate-limit.ts`, deliberately separate module/map from the
  existing MAIL-13 inbound limiter) — are checked BEFORE the user lookup; tripping either still
  returns the byte-identical accepted response, just skips the mint. **Design §5.1's one
  documented exception:** a known-but-suppressed address gets a distinguishable
  `503 {error:"delivery unavailable — contact an admin"}` — intentional, not a regression of the
  property above. `x-forwarded-for` forwarding (controller + the platform-ui route) is what makes
  the per-IP limit mean anything at all, rather than rate-limiting the whole platform behind one
  BFF-internal caller IP.

- **`POST /auth/magic-link/consume` — one atomic statement, one generic error.** `UPDATE
  auth_magic_links SET consumed_at = now() ... WHERE token_hash = $1 AND consumed_at IS NULL AND
  expires_at > now() RETURNING user_id` (the `client_invites.ts`-proven shape) is the entire
  anti-replay mechanism — Postgres's row lock serializes concurrent presentations, the loser's
  predicate sees the already-set `consumed_at` and matches zero rows. Unknown token, replayed
  token, and expired token are indistinguishable by construction: all three throw the SAME
  `MagicLinkConsumeError` (`422`, no `.reason` field of any kind — nothing for a future caller to
  accidentally leak back into a response). **Proven with a real race, not mocks:** `Promise.
  allSettled` over 8 concurrent calls, each opening its own pool connection against the real test
  Postgres → exactly 1 fulfilled, 7 rejected, same error class.

- **M11 (a magic link must never be an approval mechanism) — stated in three places.** A header
  comment at the mint site (`service.ts`), a header comment at the render site (`templates.ts`'s
  new `auth.magic_link` function, registered alongside the existing `approval.warning`/
  `approval.actionable`/`auth.shell` keys), and a pinned test
  (`src/mail/magic-link/m11-non-goal.test.ts`) asserting (a) `approval.warning`/
  `approval.actionable`'s own hardcoded wording never mentions "magic" or "token" regardless of
  the `href` they are handed, and (b) a static scan finds the `auth.magic_link` template key
  referenced nowhere outside `src/mail/magic-link/` — with exactly two named, manually-inspected
  exemptions: `templates.ts`'s own registration line, and MAIL-04's pre-existing
  `migration.test.ts`, which inserts a placeholder `mail_log` row with that template key purely to
  exercise the `'auth'` stream CHECK constraint and predates this ticket entirely.

- **Activities audit — deliberately does NOT write to the `activities` table.**
  `activities.tenant_id` is `NOT NULL` (`0001_core.sql`), and every one of the ~40 existing
  `writeActivity()` call sites in this codebase resolves a real `:tenantId` route param first —
  zero precedent for a tenant-less write, and inventing a tenant attribution for a pre-tenant-
  context auth event (which of a user's N companies? none, for an unknown address?) is exactly the
  kind of guess this ticket's brief said to avoid rather than make. Followed the codebase's own
  existing precedent instead: `src/rbac/principal.ts`'s `auditDecision` — `if (!tenantId) return;
  // global-scope decisions have no tenant feed (logged by caller)`. Implemented literally: a
  structured, token-free console audit line per mint/consume event (ids only — `userId`, `linkId`,
  `mailLogId` — never a token or its hash), plus the durable record every other kind of mail
  already relies on as its audit trail (A5): the `mail_log` row for mint, `auth_magic_links.
  consumed_at`/`consumed_ip` for consume.

- **`platform-ui/src/app/auth/magic/route.ts`** — the landing page a clicked link opens (`GET
  ?token=`). Consumes the token against the endpoint above, then mints
  **`sealSession(userId)`** — the identical plain-payload cookie shape `login/actions.ts`'s
  dev-login already produces, deliberately NOT `auth/callback/route.ts`'s OIDC-wrapped
  `encodeSession({mode:"oidc",...})` form, because a magic link is a login convenience, not an IdP
  session, and must ride the same cookie shape regardless of `AUTH_MODE`.

- **`MAIL_MAGIC_LINKS_ENABLED` stays `0` by default** — it and its compose passthrough already
  existed (MAIL-13 wired them forward for this exact ticket, per that entry's own note). This
  ticket adds the three new knobs the AC names — `MAIL_MAGIC_LINK_TTL_SECONDS` (900),
  `MAIL_MAGIC_LINK_RATE_PER_ADDRESS_HOUR` (3), `MAIL_MAGIC_LINK_RATE_PER_IP_HOUR` (10) — to
  `config.ts`, the `platform` service's `environment:` block in `docker-compose.vps.yml`, AND both
  `.env.example` files in the same change, per the standing compose-passthrough rule. Real-user
  enablement is staging §15 R5 — explicitly not this ticket.

- **Files touched:** `platform-nest/migrations/0080_auth_magic_links.sql` (new);
  `platform-nest/src/mail/magic-link/{tokens,rate-limit,service,controller}.ts` (new) +
  `{service.db,controller,m11-non-goal}.test.ts` (new); `platform-nest/src/mail/templates.ts`
  (+`auth.magic_link`, +M11 header comment) + `templates.test.ts` (pinned key list updated);
  `platform-nest/src/config.ts` (+3 vars); `platform-nest/src/app.module.ts` (+
  `MagicLinkController`); `platform-nest/.env.example` + `infra/compose/docker-compose.vps.yml`
  (+3 vars each); `platform-ui/src/app/auth/magic/route.ts` (new);
  `docs/FRONTEND-BFF-CONTRACT.md` (+2 endpoint rows + status paragraph).

- **Proof, executed (not narrated).** `TEST_DB_PREFIX=mail10agent npx vitest run src/mail src/db`
  run from `platform-nest/` → **291/291 green**, incl. `src/db/rls.test.ts` unmodified (5/5) and
  the 8-way consume race. `npx tsc --noEmit` clean. `npm run lint:migration-rls` and `npm run
  lint:withtenants` both pass. Test-DB hygiene: 22 `mail10agent_*` databases created during the
  run, all dropped afterward; `pgtest_*` count unchanged at 146 before/after (151/151 total
  databases before/after) — no orphans left in the shared `gaiada-test-pg` instance.

- **Cap: IN PROGRESS, not DEV-VERIFIED.** The live round-trip on a deployed box (mint → Mailpit
  capture → click the link → consume → cookie) is **PENDING-DEPLOY** — no deploy path exists
  while GitHub Actions is billing-blocked (per the orchestrating session, the release currently in
  flight is separately failing on an unrelated SBOM attestation issue). **No SLO claim anywhere**
  — M8's p95<60s/p99<180s auth-stream delivered-minus-queued latency SLO needs ≥7 days of real
  relay traffic (design §15 R5) and stays deferred whole, never approximated against the dev sink
  or the test suite's synchronous DB timings.

- **0.0.15 (2026-08-05, devops, MAIL-09) — mail enabled against the Mailpit sink on gda-aicenter;
  live smokes 1/2/5 PASSED, smoke 3 (ex-Q-V7) SETTLED NEGATIVE, smoke 4 not live-claimable.**
  Deploy confirmed already landed (`docker inspect gaiada-platform-1` → `alpha-01.017.0040b`).
  Schema check: `0077_mail_core.sql`/`0078`/`0079` applied (`schema_migrations`); `mail_log`,
  `mail_suppressions`, `mail_messages` all carry `relforcerowsecurity=t` + a `mail_context` policy
  (MAIL-22). **`0080_auth_magic_links.sql` is NOT applied — the table does not exist on the box.**
  `git status` shows that file **untracked** in the working tree (never committed), so it shipped
  in no release; MAIL-10/11 (batch B3) were correctly not attempted here — this ticket's own deps
  are MAIL-00/04-06 only, but the gap is recorded so nobody assumes magic links are live.
  **Tag parity fixed before touching anything:** server `.env` had `GAIADA_TAG=alpha-01.016.0037a`
  / `APP_VERSION="Alpha 01.016.0037a"` while the running container was already `0040b` — the known
  footgun where an `up -d` silently rolls a service back. Corrected both keys to `0040b` (backup
  kept) before any restart.
  **Enabled:** `MAIL_ENABLED=1`, `MAIL_LINK_BASE_URL=https://erp.gaiada.online` added to
  `infra/compose/.env` on the box; streams already pointed at `mailpit:1025`. Restarted ONLY
  `platform` with the real repo vars (`COMPOSE_PROFILES=bot,auth,whisper,mail-dev,scan`,
  `COMPOSE_FILES=-f docker-compose.vps.yml -f docker-compose.hostdata.yml`) — mailpit, clamav, and
  the standalone alertmanager project all survived `--remove-orphans`, confirmed before and after.
  **New finding + fix (compose-env-passthrough trap, a new shape):** `MAIL_STREAM_NOTIFY_FROM`,
  `MAIL_STREAM_AUTH_FROM`, and `MAIL_REPLY_DOMAIN` were present in the compose `environment:`
  block as `${VAR:-}` but absent from `.env` — so docker compose substituted an EMPTY STRING
  (not "unset"), and `config.ts` reads them with `??` (nullish coalescing), which treats `""` as
  "set" and never falls through to the compiled `*.gaiada.invalid` default. Every send got an
  empty `From:`/`Reply-To:` domain and Mailpit correctly refused it (`553 5.1.3 The address is not
  a valid RFC 5321 address` — reproduced directly against `mailpit:1025` with a raw nodemailer
  call to confirm before touching config). Fixed by setting explicit values in server `.env`
  (`Gaiada Dev <no-reply@notify.gaiada.invalid>`, `Gaiada Sign-in <no-reply@auth.gaiada.invalid>`,
  `notify.gaiada.invalid` — the SAME reserved-TLD dev defaults the code already intended, so this
  is a config fix, not a domain-literal violation of A12). All 9 queued rows from the smoke-1 test
  then sent successfully on retry.
  **Smoke 1 (suspended automation write → decider warning mail) PASSED.** Created a real suspended
  `automation_approvals` row (origin=automation, impact=high) via the live API as `hansel@gaiada.com`
  (bearer extracted from a real browser SSO login's session cookie — the `gaiada_session` cookie's
  OIDC payload is base64url, not encrypted, so the access token was readable directly; used only
  in-memory over SSH, never logged). Nine deciders were notified (self-skip correctly excluded the
  creator); mail captured in Mailpit for `owner@gaiada-creative.test`, `exec@gaiada.test`, and
  several automation service accounts. Wording verified verbatim: *"It is suspended; nothing has
  run."* — passes the M12 test (no approve/reject language, no execution implied). Link: exactly
  `https://erp.gaiada.online/approvals/<id>` — APPR-01's per-item route confirmed wired end-to-end
  from `MAIL_LINK_BASE_URL` through MAIL-06's `href`. Rejected the test row afterward to keep the
  real pending-approvals inbox clean.
  **Smoke 2 (client gate → signer portal mail) PASSED.** Opened a real `prd_sign`/`client` gate on
  the seeded "Nusa Coffee — brand site kickoff" run. Mail arrived at the seeded signer contact
  `ayu@nusacoffee.test`, template `approval.actionable` (correct wording class — a pipeline gate
  IS actionable today), subject *"Your decision is needed: Your signature is needed on the PRD"*,
  link exactly `https://erp.gaiada.online/portal/approvals/<runId>` (§7.5's portal href, confirmed
  correct). Left the gate open (real seeded client data; deciding it needs the actual client's
  portal action, out of scope here).
  **Smoke 3 (ex-Q-V7, expired-session deep-link walk) SETTLES THE OPEN QUESTION — NEGATIVELY.**
  Playwright walk with a fresh (no-cookie) browser context against smoke 1's real deep link:
  unauthenticated hit redirects to `/login` with **no `?return=` or any target preserved**, through
  a normal Keycloak login, landing on the plain dashboard **root** (`/`), not the approval detail
  page. Root cause read directly (not guessed): `platform-ui/src/middleware.ts` line 23 —
  `if (!isPublic && !hasSession) return NextResponse.redirect(new URL("/login", req.url))` —
  builds the redirect with no query/state carrying the original path at all. Design §7.5 assumed
  "the platform-ui middleware's validated `?return=` pattern" already existed and asked this
  ticket to verify it end-to-end; it does not exist. This is a real, verified gap in
  `platform-ui`'s auth middleware / `/auth/callback` route, not a mail-module defect — MAIL-05/06's
  hrefs are proven correct by smokes 1–2, they just don't survive a reauth hop today. Recommend a
  new ticket against `platform-ui` (middleware + `auth/callback/route.ts`) before this can be
  called closed; ex-Q-V7 moves from OPEN to SETTLED-NEGATIVE, not resolved.
  **Smoke 4 (OTel counters) NOT LIVE-CLAIMABLE, as the ticket itself anticipated.**
  `OTEL_ENABLED=0` on the box and no collector runs — confirmed (`env`, and a 404 on `/metrics`,
  which this app doesn't expose anyway since it pushes OTLP rather than being scraped). No
  Prometheus claim made. The counters' logic is exercised by the existing test-exporter suite
  only (already green per prior sessions) — left untouched, not re-verified here.
  **Smoke 5 (WS9 alert rules) PASSED.** Added `MailQueueDepthHigh` (`mail_queue_depth > 50` for
  15m, per design §11) and `MailSendFailureRateHigh` (>20% failure rate over 1h per stream, the A8
  "flip the transport" pager) to `infra/observability/prometheus/rules/alerts.yml`, alongside the
  pre-existing `MailAuthStreamSendFailed` (MAIL-24). `promtool check rules` (via
  `prom/prometheus:v2.55.1` --entrypoint promtool, Docker unavailable locally as a bare binary) →
  **12/12 rules in `alerts.yml`, 8/8 in `slo.yml`, both SUCCESS.** Rules are not deployed to a live
  Prometheus (the WS9 stack is opt-in and not up on gda-aicenter) — **firing is not claimable**,
  stated per the ticket's own instruction. Left the repo copy as the source of truth rather than
  hand-pushing to the server's ungitted rules copy, to avoid recreating a MAIL-21-class drift on a
  file nothing is currently consuming.
  **Confirmed unchanged:** `MAIL_MAGIC_LINKS_ENABLED=0` on the box (R5 gate untouched).
  **Cap: DEV-VERIFIED** for MAIL-04 (core send pipeline — proven live against the sink), MAIL-05
  (approval/risk tap + M12 wording — proven live), MAIL-06 (decider notifications — proven live,
  correct set, correct self-skip). **NOT promoted this session:** MAIL-13 (inbound) — its live
  replay-vs-box leg and CI-corpus proof were not exercised in this ticket, only the outbound path
  was; MAIL-15 (mail surface UI) — `/admin/mail` and the thread panels were not walked live.
  Nothing here proves deliverability, inbox placement, or the M8 SLO — those stay UNVERIFIED per
  §15 R1/R2/R5 regardless of how clean the sink evidence is.

## render-gateway-go
### [0.0.0] — 2026-07-23 · PLANNED
- Design only — the centerpiece of `blueprints/creative-design.md` §05; no code. Separate Go service
  (mirror of `ai-gateway-go`): typed render job-queue, `RenderBackend` abstraction (serverless GPU /
  self-host ComfyUI / commercial API) routed per capability+license+cost+health, ComfyUI-workflow-as-JSON,
  signed per-job I/O URLs, idempotent render-callback, fail-closed stop-loss (image $200 / video $300),
  structural license wall, egress audit. Outputs land in the `creative` DAM; job state on platform-nest rows.
- **Next:** built under the `creative` P1–P4 tickets; container-build verification before deploy.