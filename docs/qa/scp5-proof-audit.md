# SCP-5 W5-Q: proof audit (server half)

Working document for ticket W5-Q. It maps every proof item of the SCP-5 lists (BFF contract 63.24.8, 63.24.9, 63.25.5,
63.26.5, 63.27.5, 63.28.6, 63.29.6, 63.30.7) to the test that proves it. Taken on the train tip cf5c439b.
The audit reads test titles and spot-reads bodies where a title was not enough; the HTTP and DB tests run on the Linux CI gate only.

Status: PROVED, PARTIAL (what is not asserted), MISSING, then W5-Q (written in this ticket), or GAP (server differs from the contract).

Short names: `M` = `platform-nest/src/modules/social`, `P` = `M/pipeline`, `DB` = `platform-nest/src/db`, `PM` = `platform-nest/src/modules/pm`.
`NEW` = `P/report-automation-rules.http.test.ts` (new in W5-Q). `RP` = `M/social-reports-periodic.http.test.ts`.

## 63.24.8 Periodic reports

| Proof item | Where | Status |
|---|---|---|
| Migration: one CHECK on `kind`, eight kinds | `DB/social-reports-periodic-migration.db.test.ts` "admits the eight kinds and refuses any other" | PROVED |
| Period CHECK: NULL/malformed refused per new kind (`2026-W54`, `2026-Q5`, `2026-H3`, `26`), `2026-W53` admitted | same file, "each new kind takes only its period format, and a NULL period fails for each of them" | PROVED |
| Monthly, campaign, adhoc keep any period | same, "monthly, campaign and adhoc keep any period" | PROVED |
| `next_period` refused on a long kind | same, "next_period: only on daily and weekly" | PROVED |
| Unique index | same, "one live report per client, kind and period ..." | PROVED |
| `report_kinds` | same, `social_engagements.report_kinds` (two tests) | PROVED |
| Runs' CHECKs, one active run per company, kind and period | same, `social_report_runs` (ten tests) | PROVED |
| No row changed | same, "applies onto existing monthly ..." and "applying the file again ..." | PROVED |
| Each kind's range and due day, golden table | `M/report-kinds.test.ts` "the due day, per kind ..." (holiday after a daily, holiday Monday after a week, long kinds, fiscal year), "periodDateRange ...", "the range after a short report's period" | PROVED |
| One report per client, kind and period under two concurrent creates | `RP` "one report per client, kind and period: ... concurrent creates make one" | PROVED |
| Short kinds live while a draft, frozen at submit, retaken after send-back, `summary_numbers_changed` | `RP` "daily and weekly are live while a draft, ..." | PROVED |
| Long kinds frozen at create, `period_not_over` | `RP` "quarterly, semester and yearly: the period must have ended ...", "... frozen at create" | PROVED |
| `summary_missing`, `notes_incomplete` each on its own kinds; notes refused on a short kind | `RP` "summary_missing binds the short kinds only; ...", "notes_incomplete binds the long kinds only ..."; `M/report-kinds.test.ts` (pure) | PROVED |
| Officer drafts and submits every kind, cannot approve/send back/send; `company_admin` cannot approve or send; each of the four can | `RP` "every kind: the officer drafts and submits but cannot approve, send back or send; a company_admin and an automation cannot; the four can" | PROVED |
| Run: the four get every active client | `P/report-generate.http.test.ts` covers the officer's run; the HoD and GM only read progress there | PARTIAL, then W5-Q: `NEW` "who a run covers" |
| Run: an officer only their own | `P/report-generate.http.test.ts` "an officer's run: their clients only ..." | PROVED |
| Run: a member without `create` 403 | `P/report-generate.http.test.ts` "refuses: a member without create 403, ..." | PROVED |
| Run: skipped (`kind_not_due`, `internal_client`) and existing reported, never redrafted | same file, "an officer's run ...", "a second run over the same clients drafts nothing twice" | PROVED |
| Run: a throwing client `failed`, the rest finish; gateway down gives `fallback`; at most four in flight | same, "an officer's run: ... the gateway down a fallback, one failure never stops the rest, four in flight"; `P/report-run-plan.test.ts` `runBounded` | PROVED |
| Run: killed worker resumed, no client twice | `P/report-generate.http.test.ts` "a worker killed mid-run is resumed by the job ..." | PROVED |
| Run: `generation_running` | same, "one run per company, kind and period (two starts at once ...)" | PROVED |
| Run: progress read only for the run's person and the four | same, "the progress read is the run's person's and the four's" | PROVED |
| Run follows the company's rules: kind off 409 `report_kind_off`, by hand 409 `ai_drafting_off` on `POST reports/generate`; the run's `rules_ref` | only the single create was covered (`RP` "a kind the company turned off is 409 ..."); the run route and the run's `rules_ref` were not | MISSING, then W5-Q: `NEW` "generate follows the rules ..." |
| By chat: narrows to the person's clients, `via` recorded, automation refused | `P/report-generate.http.test.ts` "by chat: the agent runs as the person ..." | PROVED |
| By chat: "asks the confirm" | `P/report-generate.http.test.ts` "the tools: ..." pins `impact: medium` (the declaration that makes the hub confirm); the confirm prompt itself is the MCP hub's | PARTIAL (declaration only; the prompt is the hub's) |
| By chat: no tool approves or sends | same test: the two tools' paths do not match approve or deliver | PROVED |
| Sending publishes with each kind's title | `RP` "sending publishes each kind with its title (PV7-04a) ..." | PROVED |
| PDF carries SIMULATED when a number was simulated | `RP` "the SIMULATED rule" proves the document and the read; the delivery test asserted `simulated` undefined only | PARTIAL, then W5-Q: `RP` "W5-Q: the PDF carries the SIMULATED mark ..." |

## 63.24.9 Report automation

| Proof item | Where | Status |
|---|---|---|
| Timing golden table (month end, N-th working day, holiday, year turn, February, zone, UTC when unset) | `P/report-schedule-timing.test.ts` (pure) | PROVED |
| Job: two instances take a due schedule once | `P/report-schedules.http.test.ts` "two job instances at once claim a due schedule ONCE ..." | PROVED |
| One run per schedule and period | same, "one run per schedule and period: forced due again ..." | PROVED |
| Restart mid-run resumes, no second run | a killed run is proved for a person's run (`P/report-generate.http.test.ts`); a scheduled run goes through the same resume job and the per-schedule-period unique index (DB test) | PARTIAL (no kill test of a scheduled run) |
| Outage of three periods: latest only, `missed: 2` | `P/report-schedules.http.test.ts` "downtime: ..."; `P/report-schedule-timing.test.ts` `dueAt` | PROVED |
| Acting as the owner: `requested_by`, activity, usage carry owner and `via` | same file, the two-instance test | PROVED |
| Owner left the seat: skip, pause `owner_not_allowed`, notices; another of the four resumes and owns | same file, "an owner who lost the seat ..." | PROVED |
| Deactivated owner: `owner_inactive` | same file, "a deactivated owner ..." | PROVED |
| A `chosen` schedule keeps to the clients the owner may draft for | `P/report-run-plan.test.ts` (pure); no HTTP drive of a schedule's chosen list with a client that must be skipped | PARTIAL, then W5-Q: `NEW` "a chosen schedule keeps to the clients ..." (internal client skipped) |
| `schedule_exists` | `P/report-schedules.http.test.ts` "each of the four sets a schedule ..." | PROVED |
| Routes refuse officer, `company_admin`, automation | same file, "only the four: ..." (list, create, run, patch) | PROVED |
| Run now runs as the caller, `alreadyApplied` for a period already run | same file, "Run now runs as the presser ..." | PROVED |
| As built: PATCH never takes `kind`; scope `all` refuses non-empty `engagementIds` (400 `invalid_field`); a chosen edit needs open clients; a refused edit changes nothing; `schedule_exists` on a PATCH; the editor owns | create paths covered; PATCH validation was not | MISSING, then W5-Q: `NEW` "PATCH: ..." |
| As built: kind off or by hand pauses the schedule (`kind_off`, `ai_drafting_off`), Run now 409 with the same codes, resume does not re-check | only the DB CHECK admits those reasons; the job and the route were not driven | MISSING, then W5-Q: `NEW` "a schedule follows the rules ..." |
| Nothing in a schedule approves or sends | two-instance test: drafts are `draft`; the tools' paths | PROVED |
| Spend: a run's usage sums its calls, 30-day and month-to-date sums | `P/report-schedules.http.test.ts` "the spend: ..." | PROVED |
| Spend: nothing is refused on spend | never asserted; no budget mechanism exists on this route to drive | PARTIAL |
| The page: phone width, keyboard, axe, DEMO_MODE | UI half (platform-ui), not this ticket | out of scope here |

## 63.25.5 Ideas

| Proof item | Where | Status |
|---|---|---|
| Every CHECK with its NULL cases, both FKs, both unique indexes | `DB/social-wave5-b-migrations.db.test.ts` `social_ideas` (8 tests) | PROVED |
| Officer of another client and `company_admin` 403 `not_officer_or_approver`; the client's officer and each of the four allowed | `P/ideas.http.test.ts` "the client's officer and each of the four add ideas; the officer of another client, a company_admin, ... are 403 ..." | PROVED |
| "Add to next plan": post and idea in one transaction, a refused create leaves the idea as it was | same, "a failure AFTER the post's INSERT leaves neither the post nor the change", "the cycle: ... the idea is left as it was" | PROVED |
| Replay answers `alreadyApplied`; `cycle_closed`; another client's cycle 404 | same, "a replay for the same cycle ...", "the cycle: 400 ..., 404 ..., 409 cycle_closed ..." | PROVED |
| Two plans at once make one post | same, "two plans at once make ONE post ..." | PROVED |
| Discarding the planned post releases the idea (in the discard's transaction); archiving does not | same, "discarding the planned post gives the idea back", "the release runs INSIDE the discard's own transaction", "archiving the planned post keeps the idea planned"; `P/ideas.test.ts` `release_idea` | PROVED |
| A planned idea refuses edit and delete | same, "Add to next plan makes a planned post ..." (409 `idea_planned` for edit, share, delete) | PROVED |
| The post read's `idea` | same, "Add to next plan makes a planned post in the cycle and links both ways; the post read carries the idea" | PROVED |

## 63.26.5 Saved items

| Proof item | Where | Status |
|---|---|---|
| Each shape's CHECK with NULL cases | `DB/social-wave5-b-migrations.db.test.ts` `social_saved_items`; `P/saved.http.test.ts` "each shape's CHECK, with its NULL cases" | PROVED |
| Category the company does not have, or that does not take the shape | `P/saved.test.ts` "the categories are the company's"; `P/saved.http.test.ts` "renamed, reordered, hidden, added and removed categories ..." | PROVED |
| Removed category's items shown under "Other" | same, the SCP-Q41 test | PROVED |
| Asset FK refuses another company's group; one `asset` item per client and group | `P/saved.http.test.ts` "the asset FK refuses ...", "two adds of one asset at once make ONE item"; DB test | PROVED |
| Derived photos (design group shows as used with no saved row; removing the design makes a kept asset unused) | `P/saved.http.test.ts` "a design's group shows as used ...", "removing the design makes a kept asset unused ..." | PROVED |
| `used`, `source`, `pillar` filters | same, the `&used=`, `&source=`, `&pillar=` assertions on photos and captions; bad values 400 | PROVED |
| Author edits and deletes own item; officer and a seat anyone's; another member 403 `not_officer_or_approver` | same, "the author changes and deletes their own item; ..." | PROVED |
| `savedItemIds` counted only when the edit applies; refused for another client's item | same, "an edit that applies counts one use per item ...", "a REFUSED edit counts nothing", "`savedItemIds` is 400 ... for another client's item" | PROVED |
| Hashtag sets read from the brand book | same, "hashtag sets are the brand book's, read-only here, unpaged" | PROVED |
| Nothing of the bank reachable from the portal | same, "a client contact is 403 on every staff route of the bank, and the portal has no route for it" | PROVED |

## 63.27.5 Cycle steps

| Proof item | Where | Status |
|---|---|---|
| Migration CHECKs with NULL cases, unique index, old link values admitted, no row changed | `DB/pm-task-cycle-steps-migration.db.test.ts`, `DB/pm-task-links-migration.db.test.ts` | PROVED |
| `PUT cycles` makes six step tasks per cycle, a re-run none, no task per post | `P/cycle-steps.http.test.ts` "PUT cycles makes exactly six step tasks ..." | PROVED |
| Due dates against 63.5's golden table, with and without estimates; `report` from `report_due_day`, none without | `P/cycle-steps.test.ts` "due dates against 63.5's golden table ...", "due dates in working days"; `P/cycle-steps.http.test.ts` "without estimates ..." | PROVED |
| Each step closes on its condition and reopens (design change, reschedule, new counted post) | `P/cycle-steps.http.test.ts` "each step closes on its condition and reopens ..."; `P/cycle-steps.test.ts` | PROVED |
| `report` closes on delivery of period M-2's report only | `P/cycle-steps.http.test.ts` "the report step closes on the delivery of period M-2's report ..." | PROVED |
| New officer takes the Ball of every open step; new estimates re-date | same, "a new officer on the allocation takes the Ball ..." | PROVED |
| No project: no steps and the reason; link locked | same, "no project: no steps, ...", "no PM route moves a step task's link (409 task_link_locked)" | PROVED |
| Two stage actions on one cycle never deadlock | same, "two stage actions on posts of one cycle at once never deadlock ..." | PROVED |

## 63.28.6 Social audit

| Proof item | Where | Status |
|---|---|---|
| Fixture twins byte-equal | `P/rules.test.ts` "the seed's twins are byte-equal"; `P/ideas.test.ts` stage-machine twins | PROVED |
| Six automatic rules on a golden table, each with its reason; overall over scored dimensions only; band edges | `P/audit-score.test.ts` (golden tables, "the band edges at 75 and 50 ...") | PROVED |
| CHECKs with NULL cases, one draft per client | `DB/social-wave5-b-migrations.db.test.ts` `social_audits`; `P/audit.http.test.ts` "the table's own CHECKs ..." | PROVED |
| Final audit refuses edit and deletion; `frozen` stays put when the pipeline moves | `P/audit.http.test.ts` "a final audit refuses edit, delete and Draft with AI (409 `audit_final`) ...", "its frozen record stays put ..." | PROVED |
| Another client's officer 403, the client's officer and a seat allowed; the owner and prospect rules (as built, SCP-Q43: the four may also create a client's audit) | same, "the gates (SCP-Q34)" (client's audit, prospect's audit) | PROVED |
| Draft with AI saves nothing | same, "Draft with AI is a proposal from the scores and saves nothing" | PROVED |
| Attach once | same, "attach records the client it became: the four only, once ..." | PROVED |

## 63.29.6 Client onboarding templates

| Proof item | Where | Status |
|---|---|---|
| Payload's 400s (unknown phase or role, repeated key, offset out of range) | `PM/project-templates.test.ts` "names the path of every refusal"; `PM/project-templates.http.test.ts` "the templates routes ... name the path of a refused payload" | PROVED |
| Apply's due dates on the golden table (kickoff on a holiday, a weekend, the year turn), milestones | `PM/project-templates.test.ts` golden table (16 rows); `PM/project-templates.http.test.ts` "apply: ..." | PROVED |
| One application per project and template; a replay answers the same ids; one transaction | `DB/pm-project-templates-migration.db.test.ts`; `PM/project-templates.http.test.ts` "a replayed id ...", "the same template under a new id is 409 ...", "two applies at once ...", "ONE transaction: ..." | PROVED |
| Kickoff move re-dates only open tasks | `PM/project-templates.http.test.ts` "the kickoff move re-dates only the tasks not yet done ..." | PROVED |
| Start refused to the officer and a `company_admin` (403 `not_a_social_approver`), `no_project`, `onboarding_template_not_set` | `P/onboarding.http.test.ts` "who may start it, and in what order it refuses (SCP-Q36)" (six tests) | PROVED |
| A `client` step assigned to the officer | same, "gives the lead steps to the caller, the officer and client steps to the engagement's officer" | PROVED |
| Settings picker refuses another company's template and a `task` template | same, "must be a live `project` template of THIS company ..." | PROVED |

## 63.30.7 Company rules

| Proof item | Where | Status |
|---|---|---|
| Company with no row works on the seed at version 0; seed twins byte-equal | `P/rules.http.test.ts` "a company with no row reads the seed as version 0 ...", "... works on the seed ..."; `P/rules.test.ts` | PROVED |
| Each section's validation, one refusal per rule with its `field` | `P/rules.test.ts` (per section); `P/rules.http.test.ts` "validation: ... each 400 invalid_field" | PROVED |
| `rules_changed` on a stale `expectedVersion`; two saves at once, two consecutive versions | `P/rules.http.test.ts` "a stale expectedVersion is 409 rules_changed ...; two saves at once never take one version" | PROVED |
| Version table refuses UPDATE and DELETE | same, "the version table refuses UPDATE and DELETE ..."; `DB/social-rules-migration.db.test.ts` | PROVED |
| A report keeps its due day after the rule changes; the next takes the new rule | `RP` "a rules change applies to new reports only ..." | PROVED |
| A cycle made before a step change keeps its tasks | `P/cycle-steps.http.test.ts` "a rules change applies to new cycles only ..."; `P/rules.http.test.ts` "a cycle and a report made under version N keep N" | PROVED |
| An audit keeps its scorecard | `P/audit.http.test.ts` "a rules change after finalize leaves the final audit alone ..." | PROVED |
| A run keeps its rules | only the `social_report_runs.rules_ref` CHECKs were covered | MISSING, then W5-Q: `NEW` "generate follows the rules ..." and "a schedule follows the rules ..." |
| Kind turned off refuses create and generate | create: `RP` "a kind the company turned off is 409 report_kind_off ..."; generate: not covered | PARTIAL, then W5-Q: `NEW` |
| Kind turned off pauses its schedule | not covered | MISSING, then W5-Q: `NEW` "a schedule follows the rules ..." |
| AI drafting off makes empty drafts | `RP` same test (empty draft, no gateway call, 409 `ai_drafting_off`) | PROVED |
| An added notes area is required by the check | `RP` "an added notes area is required by the check ..." | PROVED |
| Fiscal year from April makes Q1 April to June | `RP` same test; `M/report-kinds.test.ts`; `P/rules.test.ts` | PROVED |
| A step set to `manual` is never closed by the pipeline | `P/cycle-steps.http.test.ts` "a rules change applies to new cycles only; a step set to manual ..."; `P/cycle-steps.test.ts` | PROVED |
| A moved band changes a draft audit's band | `P/rules.test.ts` "a moved band changes the band a score falls in" (pure); the `P/audit.http.test.ts` preview test checks benchmark and weights, not the band | PARTIAL (no HTTP assertion of a moved band; the preview answers `band`) |
| A hidden Saved category leaves the menu and keeps its items | `P/saved.http.test.ts` SCP-Q41 test | PROVED |
| Shared ideas print in the monthly report only when the setting is on | no test; the setting is stored and validated but nothing reads it | GAP (see below) |
| Validator has no key for who acts, the one-report rule, drafting-only AI, a schedule's owner; an unknown key refused | `P/rules.test.ts` "what is not set here stays fixed ..." (unknown key throws) | PROVED |
| Routes refuse an officer and a `company_admin` (403) | `P/rules.http.test.ts` "the officer, a company_admin, a Web Dev head, ... are 403 on every write, before the body" | PROVED |
| Preview saves nothing; history shows its diffs | `P/rules.http.test.ts` "the preview answers ... and saves nothing", "reset writes a new version ...; the history shows it newest first with its diff" | PROVED |
| The page: phone width, keyboard, axe, DEMO_MODE | UI half | out of scope here |

## Summary by section

Items in server scope (the UI "page" lines excluded). "Proved" counts items already proved before W5-Q.

| Section | Items | Proved | Partial | Missing | GAP | Written in W5-Q |
|---|---|---|---|---|---|---|
| 63.24.8 | 28 | 24 | 3 | 1 | 0 | the four's run coverage, generate refusals and run `rules_ref` (`NEW`), the SIMULATED PDF (`RP`); open: the hub's confirm prompt |
| 63.24.9 | 17 | 12 | 3 | 2 | 0 | chosen list, PATCH, kind off and by hand pausing (`NEW`); open: a scheduled run killed mid-run, "refused on spend" |
| 63.25.5 | 8 | 8 | 0 | 0 | 0 | none needed |
| 63.26.5 | 10 | 10 | 0 | 0 | 0 | none needed |
| 63.27.5 | 8 | 8 | 0 | 0 | 0 | none needed |
| 63.28.6 | 7 | 7 | 0 | 0 | 0 | none needed |
| 63.29.6 | 7 | 7 | 0 | 0 | 0 | none needed |
| 63.30.7 | 20 | 15 | 2 | 2 | 1 | run keeps its rules, kind off refuses generate and pauses a schedule (`NEW`); open: HTTP moved band; shared ideas (GAP) |

## Server gaps

1. 63.30.7 and 63.25.1: `ideas.sharedInMonthlyReport` is stored and validated (`P/rules.ts`) but nothing reads it. The monthly report's
   document and PDF never list ideas marked shared, whatever the setting. Contract text: 63.25.1 "that report's document and PDF then list its client's
   ideas marked shared since the previous monthly report, by the report's own rules" and 63.30.7 "shared ideas print in the monthly report only when the
   setting is on". No test is written because none can pass; this is a server change (the report snapshot builder).
