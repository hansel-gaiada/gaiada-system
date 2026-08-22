# SMM department — delivery tracker

**This file is the single source of truth for SMM ticket state.** It is updated as part of the work,
not afterwards.

- **Binding design:** `docs/blueprints/smm-design-addendum-2026-08-12.md` (overrides `smm-design.md` v1.0)
- **Session log + decisions:** `docs/superpowers/plans/2026-08-14-smm-session-handoff.md`
- **Ops runbook:** `docs/runbooks/social-postiz-org-ceremony.md`
- **App-review dossier:** `docs/blueprints/smm-app-review-dossier.md`

## Update protocol — read before ticking anything

1. **A ticket moves to ✅ only when it is merged to `main` AND its acceptance was verified by running
   something.** Not "the seat reported green" — this module produced five silent no-ops in one week,
   every one behind a passing suite.
2. **Record the evidence**, not the claim: test counts as passed/failed/**skipped** (three numbers), and
   whether a UI change was driven **in a real browser** or only unit-tested. A skipped suite is not a
   passing suite; an in-process test can be silent about the thing that breaks.
3. **🟡 partial is a real state.** Use it, and say in one line what is missing.
4. **Status language:** PLANNED → IN PROGRESS → DEV-VERIFIED. Never "done" or "complete".
   Distinguish **deferred** (a scheduling fact) from **blocked** (an impediment).
5. Update `docs/modules/MODULES.md` + `CHANGELOG.md` in the same commit when a module version moves.
6. Keep the **Recurring defect classes** section current. It is the most useful thing here.

---

## Scoreboard

| Phase | Landed | Total |
|---|---|---|
| P0 foundation | **6** | 6 ✅ |
| P1 publish loop | **12** | 12 ✅ |
| P2 inbox + client approval | **6** | 6 ✅ |
| PD `direct` driver (SMM-38) | **5 (38a, 38b, 38c, 38d, 38e)** | 5 phases |
| P3 content ops | **8** (+1 partial, DEV-VERIFIED for its buildable half: SMM-25 e2e) | 8 |
| P4 agents + assistant | **3** (+1 partial: SMM-35 summary-read only) | 3 |
| Decision-gated | — | 3 (1 dead) |

**Note (2026-08-23, qa, SMM-25):** the Playwright console suite landed — `e2e/social-console.spec.ts`
(13 tests, new `social` project), driven twice (8-worker parallel and single-worker serial), both
13/13. This is the whole-department merge gate the addendum named as the last outstanding piece.
The live full-stack e2e third of the original ask stays permanently deferred, not done, until D-23
clears — no live dev stack exists for anyone to point a browser at today. Zero product defects
found; every first-pass failure was a locator-precision bug in the new test file itself, fixed
without weakening any assertion (see this file's own SMM-25 evidence block, P3 table below).
platform-ui: 2615/2615 vitest, `tsc --noEmit` clean (both measured directly, not cited). Module
`social-media 0.5.18` (unchanged — no backend/UI product code touched, only `e2e/**`,
`playwright.config.ts`, and one additive `demoSocial.ts` fixture).

**Note (2026-08-23, senior-be, security follow-ups):** two of the "small follow-ups the seats named
rather than silently absorbed" are now closed — see this file's own evidence block below (just above
"What is actually left"). (A) OAuth state single-use: `social_oauth_states` + `oauth-state.ts`
replace LinkedIn's/YouTube's signed-but-replayable state; proven RED (pre-fix replay succeeded
repeatedly) then GREEN (replay now refused, typed, never a generic 500) — and a real, independent bug
found in the same pass: `YouTubeOAuthStateError` was never registered in `main.ts`'s filter list,
so a bad YouTube callback state escaped as a body-less 500. (B) SMM-22's Cerbos gap: live-probed as
ALREADY denied before any edit (the tool's simple absence from `resource_mcp_tool.yaml`'s bracket
already refuses an agent/automation-origin metered re-drive, with or without a grant) — closed as
documentation + a regression test pinning that denial, stated plainly as hardening rather than a
live hole. Module `social-media 0.5.23`.

**Note (2026-08-23, medior, SMM-27):** best-time-to-post landed — a classical-stats sweep +
suggestion chip, deliberately NOT an AI ticket. This is the LAST unbuilt ticket in the department:
P4 is now 3/3 landed (SMM-35 remains its own named partial — see that ticket's own note below). See
this file's SMM-27 evidence block (P4 table below). Module `social-media 0.5.18`.

**Note (2026-08-22, medior, SMM-35):** the assistant's "social summary" read landed; NO social write
is reachable from `/assistant` this pass (a named cross-repo gap, not a silent skip) — see this
file's SMM-35 evidence block (P4 table below). Module `social-media 0.5.17`.

**Note (2026-08-22, senior-be, SMM-26):** the MCP agent surface audit + `smm-agent-content-brief`
flow landed — see this file's SMM-26 evidence block (P4 table below). Module `social-media 0.5.16`.

**Note (2026-08-22, senior-be, SMM-22):** X metering landed — see this file's SMM-22 evidence block
(P3 table below). The scoreboard's P3 row above is now updated to 8/8 landed (SMM-25's own e2e
Playwright suite is the one still-partial item, unrelated to this ticket).

**Note (2026-08-21, medior, SMM-16):** the module-version line below still reads `0.5.11`, pre-dating
both SMM-15 (0.5.12) and this ticket (0.5.13, `docs/modules/MODULES.md`'s own entry) — flagged per
this file's own repeated cross-session-hazard note rather than silently rewritten; the merge
orchestrator reconciles this paragraph.

Module: `social-media 0.5.11 · IN PROGRESS` — publish loop **DEV-VERIFIED against the mock driver**;
live network publishing **deferred to staging** (D-23); client-review stage **DEV-VERIFIED end to
end** — backend (SMM-31) + portal UI + composer/calendar reflection (SMM-32), a real client decision
via the portal driven in a real browser and observed landing correctly in the staff Composer in the
SAME running process; metrics (SMM-21) **DEV-VERIFIED** — `pullMetrics` nightly ingest + the
Analytics tab, driven in a real browser, `main.ts` registration **confirmed landed**; the SMM-33
capability inventory + SMM-24 docs closure found the entire client-review capability group has no
MCP tool and named it plainly rather than papering over it — **both named gaps now CLOSED (this
pass, senior-be)**: three new MCP tools cover staff request/read/withdraw (portal decide confirmed
to stay undeclared, per this program's own no-portal-tool rule), and the post-status webhook's
shared `applyPostStatuses` now writes an honestly-attributed (`actor_id NULL`) `work_activity` row
for both the webhook and safety-poll paths; SMM-38 phase 38c gave `direct` its first
real capability (LinkedIn OAuth + org-page publish + media + `pullComments`); phase 38d (this pass)
adds YouTube's resumable upload (which IS the publish call for that network in this driver — no
MCP tool and named it plainly rather than papering over it; SMM-38 phase 38c gave `direct` its first
real capability (LinkedIn OAuth + org-page publish + media + `pullComments`); phase 38d adds
YouTube's resumable upload (which IS the publish call for that network in this driver — no
`schedulePost`), quota accounting against SMM-37's three real buckets (self-tracked, not a live
probe — Google exposes none), and `pullComments` via `youtube.force-ssl`, resolving the
`uploadMedia` network-routing collision 38c named by widening the port. Both networks remain
contract/unit-tested against a stub (no live LinkedIn/YouTube credential exists, D-23); phase 38e
closes the three gaps 38c/38d named and left for it — a live dispatch path DOES now reach
`direct` for real for LinkedIn (proven with a real OAuth-token row, not merely asserted), a real
YouTube title/description channel, and a durable YouTube quota counter — while reporting YouTube's
own dispatch-path flip as an open architecture question rather than wiring around it. Module:
`social-media 0.5.11 · IN PROGRESS`.
closed the three gaps 38c/38d named for it — a live dispatch path DOES now reach `direct` for real
for LinkedIn (proven with a real OAuth-token row, not merely asserted), a real YouTube
title/description channel, and a durable YouTube quota counter — but reported YouTube's own
dispatch-path flip as an open architecture question rather than wiring around it, and flagged the
resolver's own willingness to accept an unhonourable override as a related, unresolved safety gap;
**the 38e closing pass (this pass, senior-be) closes BOTH**: `dispatch.ts` now consults a
driver-declared `isUploadTerminalFor(network)` (types.ts) and, for a network whose upload IS the
publish (YouTube, on `direct`), stamps the upload's own returned id as `provider_post_id` and never
calls `schedulePost` — proven live (`dispatch.test.ts`'s (E1)–(E3)); `registry.ts#resolvePublisherForCapability`
now consults a driver-declared `coversNetworkCapability(network, capability)` and refuses EAGERLY,
typed, any override the resolved driver does not actually cover (e.g. `youtube:schedule=direct`) —
before any network call, backed by ONE map on `direct.ts` shared with its own per-method gates, never
a second hand-maintained list. `youtube:media_upload=direct` moves from "reported unsafe" to
"principle-safe, credential-gated only" — the SAME D-23 gap every other flip in this wave already
carries. Module: `social-media 0.5.11 · IN PROGRESS`.
| P3 content ops | 2 (+2 partial) | 8 |
| P4 agents + assistant | **3** | 3 ✅ |
| Decision-gated | — | 3 (1 dead) |

Module: `social-media 0.5.6 · IN PROGRESS` — publish loop **DEV-VERIFIED against the mock driver**;
live network publishing **deferred to staging** (D-23); client-review stage **DEV-VERIFIED end to
end** — backend (SMM-31) + portal UI + composer/calendar reflection (SMM-32), a real client decision
via the portal driven in a real browser and observed landing correctly in the staff Composer in the
SAME running process; asset attach (SMM-20) **DEV-VERIFIED** — files/Drive/Studio-graded assets
attach onto a variant's media, driven end to end in a real browser, `ai.imageGen` shipping inert
with its explanation rendered next to the working attach flow.

**Note (2026-08-21, medior, SMM-20):** this worktree's own copy of this tracker (and of
`docs/modules/MODULES.md`) was cut from `main` BEFORE SMM-21's landing was recorded here — the
P3 table below still shows SMM-21 as `⬜` even though the module version this file otherwise
reflects (0.5.5, pre-this-ticket) post-dates SMM-21's own evidence in other sessions' reports.
Flagged rather than silently reconstructed, per this file's own "worktrees can be cut before a
commit made in the same turn" cross-session hazard — the merge orchestrator reconciles it.

---

## P0 — foundation ✅

| # | Ticket | State | Evidence |
|---|---|---|---|
| SMM-01 | Schema: 16 tables, two RLS walls (`0105`) | ✅ | applied in production |
| SMM-30 | IAM: 36 perms, 8 Cerbos policies, 9 groups, `social_staff`/`social_manager` (`0106`) | ✅ | 6 guard suites green; UI parity 548/548 |
| SMM-03 | Cerbos policies + both arms | ✅ | absorbed into SMM-30 (bundles generate from policies) |
| SMM-02 | Module shell, contract, engagement CRUD, tool-scope, 4 MCP tools | ✅ | |
| SMM-04/04b | Postiz containment spike; 9→5 services; retargeted at the VPS over WireGuard | ✅ | deployed; ERP→Postiz 401 in 43 ms |
| SMM-05 | `SocialPublisher` port + Postiz driver + org provisioning + registry sync | ✅ | |

## P1 — publish loop on own accounts ✅

| # | Ticket | State | Evidence |
|---|---|---|---|
| SMM-08 | Composer backend, validation engine, `args_sha256` | ✅ | |
| SMM-11 | Console shell, toolkit, Calendar + Composer, `lib/social.ts` | ✅ | |
| SMM-37 | Validator gaps: media format, FB schedule window, YouTube 3-bucket quota | ✅ | |
| SMM-06 | Config plumbing + compose `environment:` passthrough | ✅ | **found the ERP receiving ZERO `SOCIAL_*` vars**; verified live: all nine reach the container |
| SMM-09 | **The publish gate** — 6-stage precondition, grant verification, edit-invalidates-approval, replay refused, no auto-retry, barred metered twin | ✅ | 66 new tests; caught the module-GUC trap in the executor |
| SMM-36 | Per-network inbox retention + purge | ✅ | LinkedIn 24h/48h documented, all others explicitly `unverified`; 14/14 on live PG after fixing a dead purge |
| SMM-10 | Dispatch + reconcile, single-transaction `approval_id`+`provider_post_id` stamp, MCP tool declared, D-22 verifier installed | ✅ | 217/217; mcp-hub 247/247 |
| SMM-12 | Calendar/Composer UX: grid, chips, drag-reschedule, quota strips, submit-with-preview | ✅ | all 16 refusal tokens rendered; **browser-driven in SMM-14** |
| SMM-13 | Events → notifications + risk-shaped mail | ✅ | 3 real defects fixed (module GUC, empty `toEmail`, vacuous assertions) + the wiring fix below |
| SMM-39 | Media upload before dispatch; refs in `uploaded_media`, outside the approval hash | ✅ | 225/225; idempotent per (variant, file); partial failure refuses |
| SMM-07 | Account connect — BFF-brokered, org-scoped, resumable | ✅ | 234/234; three new refusal codes; no migration needed |
| SMM-14 | **QA gate** — P1 e2e, golden cases, MODULES/CHANGELOG | ✅ | 289 / 0 / 0 backend · 2329 / 0 / 0 UI; 3 assertions driven in a real browser |
| — | **Consumer-loop wiring fix** (`social_post_variant`) | ✅ | `main.ts` never drained the stream; SMM-13's handlers were never invoked |
| — | **Postiz org ceremony** | ✅ | one org `Gaiada`, alias `default`; signup proven closed; key rotated twice; driver registering at boot |

## P2 — engagement inbox + client approval ⬜

| # | Ticket | State | Gate |
|---|---|---|---|
| SMM-31 | Client review backend: `social_post_client_reviews` state machine, portal decide, `portal.approve_post`, idempotent decision | ✅ **merged** | backend DEV-VERIFIED; **318 / 0 / 0** re-run on `main` by the orchestrator, `tsc` clean. UI is SMM-32's, tracked separately |
| SMM-32 | Client review portal UI: preview + approve / request-changes | ✅ **merged** | UI DEV-VERIFIED — 2392 / 0 / 0 platform-ui, `tsc` clean; browser-driven (see evidence below) |
| SMM-15 | Inbox sync (`pullInbox`, idempotent upsert) | ✅ **merged** | backend DEV-VERIFIED, evidence below — **502 / 0 / 5** (baseline 494/0/5), `tsc` clean |
| SMM-16 | AI triage: sentiment/category/urgency, spike detection, SLA | ✅ **merged** | backend DEV-VERIFIED, evidence below |
| SMM-17 | Reply flow: drafts → WS4 → send (own registry entry) | ✅ **merged** | backend DEV-VERIFIED, evidence below |
| SMM-18 | Inbox tab UI: triage queue, thread view, SLA timers | ⬜ | SMM-15 (now unblocked)/16/17 |

**SMM-15 evidence (2026-08-21, medior).** Worktree was already at the SMM-38e closing-pass merge
commit at cut time (`git log --oneline -1` matched; `git merge-base --is-ancestor HEAD main`
confirmed) — no merge was needed, stated rather than assumed. `publisher/linkedin-client.ts`,
`publisher/direct.ts`'s `NETWORK_CAPABILITIES`, and `retention-policy.ts` were all present.

New file `platform-nest/src/modules/social/inbox-sync-job.ts` (`pullTenantInbox`/`runInboxPull`/
`startInboxPullLoop`, the `smm-inbox-pull` flow). No migration — 0105/0113's existing tables and
retention columns already carry the shape needed.

**Per-post iteration, exactly as 38c named it.** `listComments(org, integrationId, since)` is called
ONCE PER `social_post_variants` row that carries a `provider_post_id` (never once per account) —
`integrationId` is that post's own provider id. The read query joins
`social_post_variants → social_accounts → social_publisher_orgs`, filtered to `status='published'`,
`provider_post_id IS NOT NULL`, a connected account, and within `config.social.inboxPull.lookbackDays`
(default 30, an operational parameter mirroring `metrics-job.ts`'s own lookback reasoning, never a
business number).

**The cursor is per (account, post), not global.** The existing thread's `last_message_at` when a
thread already exists for that (account, providerPostId) pair, else the post's own `published_at` —
no comment can predate its post, so this needs no new column. Advances automatically: the next
sweep's write updates `last_message_at` via `GREATEST(existing, new)`, so the next read's cursor
naturally moves forward. Proven in a dedicated test (see below), not merely asserted.

**Idempotency: 0105's own two unique keys, never a job-invented one.** `social_inbox_threads`'
`UNIQUE(account_id, external_thread_id)` (ON CONFLICT ... DO UPDATE, guarding the excerpt/author
columns against an already-purged thread — see below) and `social_inbox_messages`'
`UNIQUE(thread_id, external_id) WHERE external_id IS NOT NULL` (ON CONFLICT ... DO NOTHING). **Run
twice, one row, proven**: the test pulls the identical batch twice and asserts exactly one thread and
one message row exist after both runs, the second run reporting `messagesWritten: 0` for the
already-seen comment.

**Rows satisfy LinkedIn's 24h/48h purge without touching the purge.** `upsertInboxItems` writes the
SAME columns `inbox-retention-job.ts#purgeInboxRetention` already scrubs generically for any
documented-retention network. The one real interaction: 0113's own state-law CHECKs
(`sit_profile_purge_scrubs_author`/`sit_activity_purge_scrubs_excerpt`) forbid a fresh excerpt/author
on a thread whose purge marker is already set — the upsert's `ON CONFLICT` clause is
`CASE WHEN ...purged_at IS NULL THEN <new value> ELSE <existing, stays NULL> END` for exactly those
two columns, so it can never violate the CHECK. Individual MESSAGE rows carry no such guard (each is
a fresh row with its own `created_at`/purge clock) — proven against a hand-seeded, already-purged
thread: the thread's excerpt stays NULL, the new message's body lands intact.

**Quota-aware without an invented number.** `config.social.inboxPull.maxPostsPerAccountPerRun`
(default 20) caps how many posts ONE sweep asks about per account, newest-first — a SELF-IMPOSED
safety valve the config comment names explicitly as NOT a claimed LinkedIn/YouTube rate limit (D-23:
neither is published anywhere reachable without a live Developer Portal session). Proven: seeding 5
eligible posts with the cap set to 2 examines exactly 2.

**Unsupported vs empty — the ticket's own named distinction.** `resolvePublisherForCapability` does
not itself check whether the DEFAULT-resolved driver (no config override — every deployment today)
actually advertises `inbox_read`; that check belongs to the caller per `listComments`'s own "absent
member ⇒ nothing to check" contract. `pullTenantInbox` checks
`driver.capabilities.has("inbox_read") && typeof driver.listComments === "function"` before ever
calling, and an account that fails this is counted `unsupported` — proven distinct from a supported
account that genuinely has zero new comments (counted as `posts` examined, `unsupported: 0`). A
`capability_unsupported` refusal raised one layer up by the registry's own eager, data-driven check
(a misconfigured override) is folded into the same honest counter.

**The scheduled flow (`smm-inbox-pull`).** Env-gated via new `config.social.inboxPull` block
(`pullEnabled`/`pullIntervalMs`/`lookbackDays`/`maxPostsPerAccountPerRun`), dark by default — the SAME
`withGlobal` (tenant list) → per-tenant `withTenants([tenantId])` transaction → per-tenant
try/catch-and-log shape `inbox-retention-job.ts`/`metrics-job.ts` already use. `main.ts` was **not**
edited (off-limits to this ticket) — the exact line for the orchestrator to add, alongside the
existing `inboxRetention`/`reconcileEnabled` gates:
```ts
if (config.social.inboxPull.pullEnabled) {
  startInboxPullLoop(config.social.inboxPull.pullIntervalMs);
  console.log(`social inbox pull (smm-inbox-pull) on: every ${config.social.inboxPull.pullIntervalMs}ms`);
}
```
plus the import: `import { startInboxPullLoop } from "./modules/social/inbox-sync-job";`

**The module GUC — self-declared, regression-pinned.** `upsertInboxItems` calls
`declareSocialModuleScope` before touching a row; the module-GUC regression test calls it on a
caller-side transaction with NO `{modules:['social']}` option and asserts a real row exists
afterward — fails with "threadsWritten: 0" if that declaration is ever removed.

**A locally-scoped test driver, not `mock-driver.ts`.** That file (off-limits, read-only) has no
per-post-configurable `listComments` stub — `inbox-sync-job.test.ts` builds its own small
`SocialPublisher` shape scoped to the file, so no shared module-level mock state can leak between
`it()`s in file-declaration order (this file's own recurring defect class #7).

Test counts: **502 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** by stashing this
ticket's changes: **494 / 0 / 5**, matching the 38e closing pass's own stated figure; +8 new, all in
`inbox-sync-job.test.ts`, also re-run ALONE afterward — 8/8 green — ruling out the shared-test-Postgres
phantom-failure class this file names). `tsc --noEmit` clean.
`lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/`lint:migration-names` all green (no
migration — still 127 files). `test:iam-chain-alignment` not re-run (no Cerbos/IAM change; no MCP
tool declared — this is a process-level scheduled sweep with no tool of its own, the same shape
`metrics-job.ts`/`inbox-retention-job.ts` already use).

**Anything the spec did not answer, named rather than silently decided:** (1) SMM-16/17/18 remain
unbuilt, so this ticket writes rows no UI yet renders; (2) `social_inbox_messages.source`'s CHECK
admits only `'postiz_sync'`/`'reply'` — every inbound sync, `direct`-routed or not, is written as
`'postiz_sync'` because that is the only inbound token the CHECK admits (a naming quirk, not a schema
gap needing a migration — flagged rather than silently worked around); (3) whether a `dismissed`/
`closed` thread should ever reopen when fresh comments arrive is left to SMM-16/17/18 — this sync
never touches `status` on conflict, so it cannot silently reopen a thread a human closed on purpose.

**SMM-16 evidence (2026-08-21, medior).** Worktree was BEHIND at cut time — `git log --oneline -1`
did not match `main`'s tip (SMM-15's own merge commit plus an unrelated monitoring ticket had
landed) — `git merge main` (fast-forward, clean) pulled `inbox-sync-job.ts` and the
`202608211136_social_inbox_message_source_provenance.sql` follow-up in before any of this ticket's
own code was written, stated rather than silently assumed, per this file's own repeated
cross-session-hazard note. A watchdog stall mid-session was checkpointed by the orchestrator onto
this branch (`ff1df2a`) and resumed from there — no work lost, restated here for the record.

New migration `202608211200_social_inbox_triage.sql`: `category`/`urgency`/`ai_triage_status`/
`ai_triage_at`/`sla_alerted_at` on `social_inbox_threads`. 0105's existing `sentiment` column is
REUSED (its dead `'urgent'` enum value stays in the CHECK, same "history, never rewritten" idiom as
the provenance migration's `'postiz_sync'`, but this ticket never writes it — urgency is now its own
axis). Registered in `index.ts`'s `migrations` array at write time.

**The classification schema, and how unclassified differs from neutral.** `ai_triage_status` is
`unclassified` (never attempted) | `unavailable` (attempted; gateway down/unconfigured/unparsable —
NEVER a guessed value) | `classified` (a real model answer) | `purged` (was classified, then
scrubbed on the retention clock, see below) — `capabilities.ts`'s own three-reasons discipline
applied to a classification instead of a capability. `sit_triage_shape`, a structural CHECK in the
0106/0113 idiom, makes exactly one of those four shapes hold: `sentiment='neutral',
ai_triage_status='classified'` (the model looked and said neutral) is a DIFFERENT, distinguishable
fact from `sentiment=NULL, ai_triage_status='unclassified'` (nobody has looked yet) — a single
nullable column could never tell those apart, which is precisely the ticket's own named risk
("launder a guess into a fact"). `ai-drafts.ts`'s new `parseTriageDraft` has NO deterministic
fallback (unlike every other `parse*` in that file) for exactly this reason: malformed/
out-of-vocabulary/absent gateway output returns `result: null`, and the caller writes `unavailable`,
never a placeholder classification sitting in the same column a real one would occupy.

**THE CROSS-CLIENT LEAK TEST, and exactly what it proves.** Unlike SMM-19/SMM-23, there is no WS8
retrieval step here to be a second leak boundary — the only safety property is "one gateway call
gets one thread's own messages, never two threads' text in one prompt". `inbox-triage-job.test.ts`'s
(T1)/(T1b) seed two threads under two DIFFERENT clients in the SAME tenant, each with a distinctive
marker string in its own comment text, classify both in the SAME sweep (`pullTenantInboxTriage`),
and assert every gateway prompt containing one client's marker NEVER contains the other's, in both
directions — proving the sweep never batches two threads into one prompt and never crosses a client
boundary within a tenant, the worst defect this module could ship on this surface.

**Is a text-derived label subject to LinkedIn's retention cap? Yes, and it is wired into SMM-36's
existing purger, never a second job.** A sentiment/category/urgency label is distilled from the SAME
comment text the 48h activity-content cap governs (addendum §A4e); reasoned that it inherits the
SAME cap on the SAME clock (`activity_content_purged_at`) rather than a second, driftable one.
`sit_activity_purge_scrubs_triage` (structural CHECK) makes a purged row unable to hold a live
`classified` state; `inbox-retention-job.ts#purgeInboxRetention`'s EXISTING activity-content UPDATE
was extended (not a new purger, not a new job) to null `sentiment`/`category`/`urgency` and flip
`'classified' → 'purged'` in the SAME statement that already scrubs the excerpt.

**Spike-detection baseline — config, not a constant, and why.** No account is connected and app
reviews are deferred to staging (D-23) — there is NO real traffic to derive a measured baseline
from. `config.social.triage.slaGuard.{spikeWindowMinutes: 60, spikeBaselineWindows: 24,
spikeMultiplier: 3, spikeMinRecentCount: 5}` are self-imposed operational defaults with their
rationale written in `config.ts` itself (the multiplier is deliberately generous; the absolute floor
exists ONLY to stop a near-zero baseline from making one ordinary comment read as a spike) — never
presented as measured or vendor-claimed. (T8)/(T8b) prove a real burst crosses the floor and
ordinary low volume does not. Named limitation: no persistent dedup, so a sustained spike re-fires
every sweep tick — stated rather than silently solved, since there is no live traffic yet to
validate a dedup window against.

**SLA guard flows over 0105's existing `sla_due_at` + `ix_social_inbox_threads_sla`, never an
invented threshold.** `social_engagements.tool_scope.inbox.slaMinutes` (0105's OWN example shape) is
the only source of a response-time target: `refreshThreadSla` sets
`sla_due_at = last_message_at + slaMinutes` for every open thread whose engagement configured it,
and — proven by (T6b) — assigns NO `sla_due_at` at all when an engagement never set `slaMinutes`,
never a fallback duration invented to give it one. `findAndMarkSlaBreaches` uses the EXISTING SLA
index to find breaching threads, alerts once per breach (`sla_alerted_at` dedup, re-arming when
`sla_due_at` next moves forward — (T7) proves both the single alert and the re-run no-op), and
emits `social.inbox.sla_breached`/`social.inbox.spike_detected` on the ALREADY-DRAINED
`"social_post_variant"` stream (SMM-31's own precedent) — no `main.ts` stream registration needed,
only the two new scheduled-loop lines below. Urgency classification is deliberately informational
ONLY and never shrinks/extends `sla_due_at` — doing so would mean inventing an "urgent posts get N%
less time" multiplier this ticket has no data to justify, the same "don't invent thresholds"
instruction the spike knobs are held to.

**Two new event handlers** (`event-handlers.ts`, registered in `index.ts`'s `eventHandlers`):
`social.inbox.sla_breached` (bell + mail, risk-shaped — a customer-visible thread missed its own
configured window, the SAME reasoning `handlePostFailed` uses) and `social.inbox.spike_detected`
(bell only — no measured baseline exists to justify escalating to a risk-warning email).

**The module GUC — self-declared everywhere, each with its own regression test.** Every read/write
function in `inbox-triage-job.ts` (classification write, SLA refresh, SLA breach detection, spike
detection) declares its own module scope via `declareSocialModuleScope`. (T2)/(T6)/(T7)/(T9) each
call the function on a transaction with NO `{modules:['social']}` option and assert a real row
changed — fails with a silent zero if any one declaration is ever removed.

**`main.ts` — not edited (off-limits). Exact lines for the orchestrator to apply**, alongside the
existing `inboxPull`/`inboxRetention` gates:
```ts
import { startInboxTriageLoop, startInboxSlaGuardLoop } from "./modules/social/inbox-triage-job";
// ...
if (config.social.triage.classifyEnabled) {
  startInboxTriageLoop(config.social.triage.classifyIntervalMs);
  console.log(`social inbox triage (smm-inbox-triage) on: every ${config.social.triage.classifyIntervalMs}ms`);
}
if (config.social.triage.slaGuard.guardEnabled) {
  startInboxSlaGuardLoop(config.social.triage.slaGuard.guardIntervalMs);
  console.log(`social inbox SLA guard (smm-inbox-sla-guard) on: every ${config.social.triage.slaGuard.guardIntervalMs}ms`);
}
```

Test counts: **522 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts`. Baseline: SMM-15's OWN stated figure (immediately
prior entry, above) is **502 / 0 / 5** — this pass did NOT re-stash-and-measure it directly (the
sandbox's git-safety layer refused `git stash` mid-session), so it is cited rather than re-verified;
the delta is independently checkable by counting new `it()` blocks: +20 (13 in
`inbox-triage-job.test.ts`, 7 in `ai-drafts.test.ts`'s new `buildTriagePrompt`/`parseTriageDraft`
cases), which is exactly 522 − 502. `inbox-triage-job.test.ts` was ALSO re-run ALONE (13/13 green)
per this file's own "shared test Postgres + a loaded machine produce phantom failures" instruction —
its first run surfaced 5 real defects in the test fixtures themselves (a missing `approval_id` on a
seeded variant, an invalid `users.kind` literal, a Postgres `make_interval` type mismatch, and two
tests sharing a tenant whose OTHER tests' accounts polluted a tenant-wide spike-detection scan), all
fixed before this count. `tsc --noEmit` clean.
`lint:withtenants`/`lint:migration-names`/`lint:postiz-deps` all green.
`lint:migration-rls` flags ONE pre-existing failure on `202608211136_social_inbox_message_source_
provenance.sql` (SMM-15's own follow-up migration, landed before this ticket started and untouched
by it — confirmed via `git diff` against the merge-base) — not introduced by, and out of scope for,
this ticket. `test:iam-chain-alignment` not re-run (no Cerbos/IAM change; no MCP tool declared —
this is a process-level scheduled sweep with no tool of its own, the same shape
`metrics-job.ts`/`inbox-retention-job.ts` already use).

**Anything the spec did not answer, named rather than silently decided:** (1) urgency classification
never shrinks/extends `sla_due_at` (see above); (2) a thread with no `post_variant_id` (a DM/mention
not tied to a post) gets neither an SLA target nor a notification path — counted `unnotifiable`,
never silently dropped, left to SMM-17/18; (3) spike detection has no persistent dedup; (4) spike
notification resolves an account's engagement as "most recently created active engagement for that
client" when a client has more than one — a documented simplification, not a schema guarantee.

**SMM-17 evidence (2026-08-21, senior-be).** Worktree was NINE seats behind at cut time — `git log
--oneline -1` did not match `main`'s tip (SMM-15's own merge, SMM-16's own merge, and an unrelated
monitoring ticket had all landed) — `git merge main` (fast-forward, clean) pulled `inbox-sync-job.ts`,
`inbox-triage-job.ts` and the `202608211200_social_inbox_triage.sql` migration in before any of this
ticket's own code was written, stated rather than silently assumed, per this file's own repeated
cross-session-hazard note.

**No migration.** 0105's own schema for `social_inbox_messages` — `direction`/`body`/`status`
(`draft|in_review|approved|sent|failed`)/`approval_id`/`args_sha256`/`external_id` plus the
`sim_sent_reply_has_approval` CHECK and the partial `ux_social_inbox_messages_approval` unique index —
already anticipated exactly this flow ("outbound replies are one-shot-gated exactly like publishes",
0105's own table-10/11 header). The one net-new dial is `tool_scope.inbox.reply` (a boolean,
additive to 0105's existing example `tool_scope` shape) — jsonb, so no migration.

**Reuses SMM-09's pattern, not a reimplementation.** New `reply-precondition.ts` mirrors
`publish-precondition.ts` structurally: `SOCIAL_REPLY_TOOL = "social.sendReply"`,
`SOCIAL_REPLY_TOOL_CLASSIFICATION = {...SOCIAL_PUBLISH_TOOL_CLASSIFICATION}` (spread, never retyped —
those two literals are the D14 gate), its own `REPLY_REFUSAL` vocabulary (10 tokens, kept apart from
`PUBLISH_REFUSAL`/`DISPATCH_REFUSAL`/`CLIENT_REVIEW_REFUSAL` — never folded in), a four-stage chain
(`scope → hash → unconsumed → retention`, replacing publish's `quota`/`budget`/`creator_info` with a
single `retention` stage a text reply actually needs), `replyLockKey` (the messageId — the unit of
the outbound act, mirroring `publishLockKey`'s variantId reasoning verbatim), and its own
`declareSocialModuleScope` self-declaration. New `reply-dispatch.ts` mirrors `dispatch.ts`'s two-phase
shape (lock + precondition re-run with no network I/O, then the network call OUTSIDE the transaction,
then ONE guarded UPDATE stamping `approval_id` + `external_id` + `status='sent'` together) — its own
small `REPLY_DISPATCH_REFUSAL` vocabulary (`approval_not_resolvable`/`reply_stamp_race_lost`/
`capability_unsupported`/`reply_send_failed`), reusing `resolveDispatchOrgHandle` (the SAME
(network, capability) switch `inbox-sync-job.ts` already resolves `inbox_read` through) rather than
a plain `openOrg`, so a future config override or a future `direct` `sendReply` implementation routes
correctly with no change here. `core/approval-executables.ts`'s new SMM-17 section registers
`social.sendReply` with `lockKey: socialReplyLockKey`, `precondition: socialReplyPrecondition`
(a thin adapter over `evaluateReplyPrecondition`) and **`neverAutoRetry: true`** — independently
re-derived (not copied on the assumption "publish does it so reply should too"): a reply is an
outbound public write whose landed-or-not is unobservable in the ambiguous window
(`hub_unreachable`/`tool_error`), so an unattended second attempt is a coin-flip on a duplicate public
reply, exactly the property that makes publish opt out too. `cerbos/policies/resource_mcp_tool.yaml`'s
executable-tool list gets `social.sendReply` alongside `social.publishPost` (D14-13's both-halves-move-
together doctrine) — no metered twin exists for replies, so there is no bar to register.

**The retention question, answered — this ticket's own named design question.** If a draft reply
quotes or embeds the comment it answers, that quoted text is subject to LinkedIn's SAME 48h
activity-content cap the source comment carries (the SMM-16 precedent, applied to a copy instead of a
derived label). Free text cannot be reliably inspected for a quote, so the answer mirrors D-22's
TikTok doctrine: FAIL CLOSED ON UNKNOWN. The precondition's `retention` stage refuses
`source_content_purged` the instant the THREAD's `activity_content_purged_at` is set, whether or not
the reply's own text happens to quote anything — reusing the EXISTING column SMM-36's purger already
maintains; no new column, no second job. Proven direct (registry test C8/C9), through the real
executor (D2/D3) and through the real dispatch function and the real HTTP endpoint alike (all four
layers refuse/pass identically).

**A real, pre-existing defect found and fixed in SMM-36's purger, not introduced by this ticket.**
`inbox-retention-job.ts`'s two per-message purge UPDATEs (profile + activity windows) matched ANY
message row past the age threshold with no `direction` filter — correct while every row was inbound
(all SMM-15/16 ever wrote), but wrong the instant an outbound reply row exists on the SAME table: our
own authored reply text is not a member's social-activity content LinkedIn's cap is about, and wiping
it — including on an ALREADY-SENT reply, which is our own historical record — would be an over-broad
application of a rule about someone else's data. Fixed with `m.direction = 'in'` on both UPDATEs;
proven by a new case seeding a 60h-old (past both windows) outbound 'sent' reply alongside an inbound
message on the same thread and asserting the outbound row's body/author_handle survive untouched while
the thread's own `activity_content_purged_at` still fires on schedule.

**Unsupported vs failed, at dispatch.** `reply-dispatch.ts` checks
`driver.capabilities.has("inbox_reply") && typeof driver.sendReply === "function"` BEFORE ever
calling, the same "unsupported vs empty" discipline `inbox-sync-job.ts` uses for `listComments` — an
unsupported network refuses `capability_unsupported` and a genuinely failed send refuses
`reply_send_failed`, proven as two distinct, never-conflated outcomes (`reply-dispatch.test.ts`
(T2)/(T3)). The mock driver's default shape (no `withInbox`) has neither `sendReply` nor
`inbox_reply` — matching Postiz's real, documented answer (spike §8b) — and `direct.ts`'s own header
still names `sendReply` as absent, out of THIS phase's scope (SMM-38's own future phase, not this
ticket's); every test here drives the mock, never a real network, per D-23.

**Single-use grant verified, replay refused, two independent mechanisms — same shape as publish.**
(1) the approval's own `execution_status='pending'→'executing'` single-use claim (the executor's, not
this ticket's code) makes a redelivered `decided` event or a retry-endpoint call on an already-
executed row a no-op; (2) the DOMAIN side — `social_inbox_messages.external_id`/`status='sent'` — 
makes a SECOND, never-executed approval filed for a message that already sent refuse `already_sent`
before ever reaching the hub. Both proven through the real executor (registry test F1/F2) and through
the real dispatch function directly (`reply-dispatch.test.ts` T6).

**Endpoints added** (all under `/api/:tenantId/modules/social/`, `social.controller.ts`):
`POST threads/:threadId/messages` (create draft, Cerbos `assign`), `PATCH .../messages/:messageId`
(edit — EDIT INVALIDATES APPROVAL, same D-15 statement shape as `updateVariant`), 
`POST .../messages/:messageId/approve` (mark approved, idempotent, `assign`),
`GET .../messages/:messageId/send-preconditions` (dry run, `read`, mirrors
`getVariantPublishPreconditions`), `POST .../messages/:messageId/send` (**the D14 dispatch endpoint**,
`reply` — reachable in the ordinary flow ONLY through the executor's re-drive, exactly like
`dispatchPublish`), `GET threads/:threadId/messages` (list, `read`, for verification — SMM-18's own
triage-queue UI is not duplicated here). Five new MCP tools declared in `index.ts`
(`social.createReplyDraft`/`updateReplyDraft`/`approveReplyDraft`/`checkReplySendPreconditions`/
`SOCIAL_REPLY_TOOL`), matching this controller's own "every capability is an McpToolDef with the SAME
authorize() call" doctrine. Cerbos split matches `resource_social_inbox.yaml`'s (SMM-30) own
documented split verbatim: drafting/editing/approving rides `assign` ("a draft is a row in our DB...
never this action"), sending rides `reply` — and BOTH `social_staff` and `social_manager` hold both
(the inbox is the agency's working surface, unlike publish's manager-only tier — proven end to end by
a staff persona completing the full draft→send loop over real HTTP).

**The `message`-vs-`error` trap, asserted on the live endpoint.** `sendReply`'s refusal rides
`message`, never `error`, mirroring `dispatchPublish`'s own documented trap-avoidance — proven against
the real running app (`social-reply.test.ts`), not just the filter in isolation.

**Anything the spec did not answer, named rather than silently decided:** (1) there is no dedicated
"approve" endpoint for `social_post_variants` (publish's own equivalent state transition) anywhere in
this codebase yet — SMM-17 built one for `social_inbox_messages` because the reply flow has nothing
else to test end-to-end against, but that gap on the publish side is unrelated and out of this
ticket's scope, flagged rather than silently fixed; (2) no metered-reply path exists or was
considered — D-14's money split is specific to publishing, and nothing in the addendum proposes a
metered reply, so `social.sendReply` has no barred twin; (3) SMM-18 (inbox tab UI) still owns the real
triage-queue read surface — `listThreadMessages` here is a verification convenience, not a queue.

**Test counts: 559 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `d14-smm-17-social-reply-registry.test.ts` + `social-client-review-portal.controller.test.ts` (the
exact four-file set SMM-16 measured its own 522/0/5 baseline against). **+37 new**: 22 in the new
`d14-smm-17-social-reply-registry.test.ts`, 6 in `reply-dispatch.test.ts`, 8 in
`social-reply.test.ts`, 1 in `inbox-retention-job.test.ts`'s new direction-fix case — arithmetic
matches exactly (522+37=559), and this pass RE-RAN THE SAME FOUR-FILE SET TWICE independently (once
mid-fix, once final) landing on 559/0/5 both times.

Baseline was attempted **measured directly**, not just cited: `git stash -u` cleanly stashed every
file this ticket touched (both modified and new/untracked — the sandbox's git-safety layer did NOT
refuse it this time, unlike the SMM-16 seat's own experience), the three-file baseline set was re-run
against the stashed-clean tree, and it came back **495 passed, one file crashed
(`publisher/provisioning.test.ts`'s `afterAll` threw `Cannot read properties of undefined (reading
'close')` — `app` itself was never assigned, meaning `buildApp()` in that file's OWN `beforeAll`
failed on the unmodified tree), 32 skipped** — a file that passed 27/27 in every one of this ticket's
OWN runs, on code this ticket never touches, failing only on the stashed tree. Read as exactly the
phantom-failure class this file names by name (**shared test Postgres + a loaded machine**), not a
real regression, and NOT trusted as the baseline number. The stash was popped back immediately
(`git stash pop`, clean, all nine touched files + five new files restored intact) rather than
re-attempted a second time, given this file's own instruction to re-run alone rather than fight the
environment repeatedly. **SMM-16's own previously-measured 522/0/5 for this identical set** is used
instead, corroborated by the exact +37 arithmetic above and by two independent clean 559/0/5 runs of
the full set WITH this ticket's changes present — if 522 were wrong, that arithmetic would not land
on the same number twice.

All five new/touched test files also re-run ALONE (each green, matching their in-context counts:
22/22, 6/6, 8/8, 10/10 for `inbox-retention-job.test.ts`), ruling out both the shared-test-Postgres
and the in-process shared-mock phantom-failure classes this file names. `tsc --noEmit` clean.
`lint:withtenants`/`lint:migration-rls`/`lint:migration-names`/`lint:postiz-deps` all green (no
migration — still 129 files). `test:iam-chain-alignment` not re-run — no Cerbos policy CHANGED
behaviour (`resource_social_inbox.yaml`'s `assign`/`reply`/`read` actions already existed, unedited;
`resource_mcp_tool.yaml`'s executable-tool list is mcp-hub-side and not exercised by this suite).

**SMM-31 evidence (2026-08-20, senior-be):** schema/IAM already seeded (0105/0106) — no migration, no
Cerbos change this pass. Built: staff request/read/withdraw (`social.controller.ts`, idempotent
upsert on 0105's `UNIQUE(variant_id)`), the portal decide endpoint (new
`SocialClientReviewPortalController`, modelled on `PortalController.decideGate`, guarded
single-row UPDATE, no advisory lock needed), the submission precondition
(`evaluateClientReviewPrecondition` + `evaluatePublishPreconditionWithClientReview` — composed IN
FRONT of SMM-09's pinned six-stage chain, never folded into it), a new small refusal vocabulary
(`CLIENT_REVIEW_REFUSAL`, 5 tokens, kept apart from `PUBLISH_REFUSAL` the same way `DISPATCH_REFUSAL`
is), and notifications riding the already-drained `"social_post_variant"` consumer stream (two new
`event-handlers.ts` routes). Idempotent decision proven with an assertion (`decided_at` unchanged,
exactly one outbox row after two identical decide calls), not merely asserted. Two regression tests
were driven RED first — the `declareSocialModuleScope` call each new code path needs was temporarily
deleted and the corresponding test failed exactly as predicted, then restored. **318 / 0 / 0** across
`src/modules/social` + `d14-smm-09-social-publish-registry.test.ts` + the new portal controller test
(was 289/0/0). `tsc --noEmit` clean. `lint:withtenants`/`lint:migration-rls`/`lint:migration-names`
green. `test:iam-chain-alignment` green (25/25, unaffected). Full detail:
`docs/modules/MODULES.md`'s social-media 0.5.3 entry, `docs/FRONTEND-BFF-CONTRACT.md` §19/§16h.

**SMM-32 evidence (2026-08-20, senior-fe).** Worktree started at the merge-base BEFORE SMM-31 landed
on `main` (a cut-before-commit hazard, per this file's own cross-session-hazards section) —
`git merge main` (fast-forward, clean) pulled the real backend contract in before any UI code was
written; flagged here rather than silently worked around, since guessing at an unmerged contract is
exactly the "frontend-first drift" this program keeps naming.

Portal: `lib/portal.ts` (`PortalSocialReview`, `socialReviewStatusLabel`, `describeSocialReviewError`),
`portal-data.ts` (`listPortalSocialReviews`/`getPortalSocialReview` — the latter derived from the list,
since §16h has no single-review GET), `portalActions.ts` (`portalDecideSocialReview`,
`useActionState` shape — NOT the void gate-decide shape, because a genuine 409 must be shown, not
swallowed), `PortalSocialReviewDecideForm.tsx`, `PortalBits.tsx`'s new `PortalSocialReviewStatus`, and
two new routes: `/portal/social-reviews` (list, pending-first) + `/portal/social-reviews/[reviewId]`
(detail + decide). New "Post reviews" portal tab, deliberately un-badged (the count would need a new
always-on fetch on every portal page load; `portal/overview`'s `needsYou` was not extended for this
surface by SMM-31).

Staff (composer + calendar): `socialShared.ts` mirrors `CLIENT_REVIEW_REFUSAL` (5 tokens) by hand plus
a NEW `evaluateClientReviewState` — a client-safe re-implementation of
`evaluateClientReviewPrecondition` (same 5-way branch + the staleness check against the live
`argsSha256`) — and widens `PublishPreconditionResult.stage` to accept `"client_review"` (the REAL dry
-run response can carry it; this is data the EXISTING "Check now" preview button already renders once
the type/labels exist — no new UI needed for that path). `lib/social.ts#getClientReview` +
`lib/socialActions.ts#requestClientReview`/`withdrawClientReview`. `VariantCard.tsx`'s new
`ClientReviewPanel`: ask / re-ask / withdraw, gated on `social.client_review.{request,withdraw}`.
`CalendarGrid.tsx`'s chips show the RAW status only (never `stale` — the rollup carries no
`argsSha256` to compare against; only the Composer, which reads the full variant, renders that token).
Three new `rbac.ts` capabilities (`social.client_review.{read,request,withdraw}`), verified against
`role-permission-bundles.json` (not inferred): `social_staff` read+request only, `social_manager`/
`company_admin`/`manager`/`platform_admin` all three, `group_executive` read only (wholesale-excepted
from the per-pair parity guard, same as every other `social.*` cap for that role) — `rbac-capability-map.ts`
entries added so `rbac-capability-parity.test.ts` (742 cases) stays green rather than silently
un-covering three new grantable permissions.

**A real, pre-existing DEMO_MODE gap found and closed, not introduced by this ticket**:
`lib/demoSocial.ts` never had a `GET engagements/:id/scope` route at all — `lib/social.ts`'s
`getEngagementScope` silently fell through every dispatcher to `readGuarded`'s `EMPTY_SCOPE`
fallback (`requiresClientOk: false`). Invisible for the Composer's own panel (renders regardless of
the toggle, using it only for one line of copy) but it fully defeated the Calendar's chip feature,
which gates its per-variant review fetch on that exact flag — and, unrelated to this ticket, the
pre-existing engagement-scope editor page (`departments/[deptId]/engagements/[engagementId]`) was
silently reading the same fallback the whole time. Closed with one `GET` route; not a migration, not
a contract change — a fixture gap.

DEMO_MODE state added, `globalThis`-pinned from the start (learned the hard way by `demoSocial.ts`
itself on 2026-08-20, restated in this pass rather than repeated): a `clientReviews` array on the
SAME `SocialStore` the existing engagements/accounts/posts already share, plus a second engagement
(`soc-eng-2`, `requiresClientOk: true`, kept SEPARATE from the original `soc-eng-1` specifically so
SMM-12's own "healthy dry run passes ok:true" demo scenario was not disturbed) with four new
variants seeded across `pending`/`approved-but-stale`/`changes_requested`/`not_requested` — every
one of the five refusal tokens is reachable by simply opening the Composer, and the
request→pending→withdraw→re-request loop is drivable live starting from the one `not_requested`
seed. A second dispatch function, `socialClientReviewPortalDemo` (new export, wired into
`demoFixtures.ts` before `portalDashboardDemo`), answers `/api/:t/portal/social-reviews[...]`,
reading/writing the IDENTICAL store — never a second copy — so a staff "ask" and a client "decide" in
two separate browser sessions against the SAME running dev server agree on the one row.

**Driven in a real browser (`DEMO_MODE=1 npm run dev`, Playwright, headless Chromium; `next build`
NOT re-run this pass per the ticket's own "don't run it repeatedly" instruction — `tsc`+vitest are
the gate here):**
- **Composer, all 5 tokens as themselves.** `pending` → *"Waiting on the client — they haven't
  decided yet."* · `changes_requested` → the token's sentence PLUS the client's own comment
  ("Please swap the second photo…") · `client_review_stale` → *"The client approved this, but the
  content has changed since — their approval no longer matches what's here now. Ask again before
  this can publish."* (the exact "approved something that then changed" honesty the ticket brief
  named). `not_requested` → "Ask client to review" button.
- **The full staff request → pending → withdraw → withdrawn → re-request → pending loop**, driven
  live on one variant (`soc-var-10`): each click's resulting state read back correctly, proving the
  idempotent upsert reuses the SAME row rather than creating a second one.
- **The EXISTING "Check now" publish-precondition preview** (unmodified UI, only the type/label
  widening) correctly renders `stage: "client_review"` with the honest sentence — proving the
  widened `PublishPreconditionResult.stage` union and the new `REFUSAL_LABELS` entries reach that
  pre-existing code path with zero new rendering logic.
- **Calendar chips** show `Client: pending` / `Client: approved` / `Client: changes requested` next
  to the ordinary status badges, on both scheduled and unscheduled posts — confirmed the chip on the
  STALE post reads `Client: approved` (the raw status), never `stale`, exactly matching the
  documented "the calendar cannot detect staleness" limitation.
- **Portal: list + decide, both directions.** `/portal/social-reviews` (logged in as
  `dana@northwind.example` → `demo-client`) showed the one pending review first and the two
  resolved ones under "Past reviews" with the correct labels ("Awaiting your decision" /
  "Changes requested" / "Approved"). Approved the pending one via the real decide form.
- **The idempotent-decision / no-second-decision guarantee, driven as a genuine two-tab race**, not
  merely asserted: two browser tabs opened the SAME pending review; tab 1 approved it; tab 2 (still
  holding the now-stale pending form, never told to refresh) submitted `changes_requested` against
  the ALREADY-approved review and received the honest conflict message — *"This was already decided,
  and it doesn't match what you just submitted — refresh the page to see the current status."* —
  never a crash, never a silent flip. Reloading tab 2 afterwards showed `Approved`, `Decided 20 Aug
  2026`, and **no decide buttons anywhere on the page** — the resolved-review-prevents-a-second-
  decision property, proven by removing the control from the DOM entirely, not just by disabling it.
- **Cross-session consistency, end to end.** After the portal decision above, re-opening the SAME
  variant's Composer card (a SEPARATE staff browser session, same running dev server) showed *"The
  client approved this exact content on 8/20/2026"* in green, and the "Check now" preview correctly
  advanced PAST the client-review gate to the next real blocker (`unconsumed` / `variant_not_approved`
  — the variant still needs a staff-side WS4 approval before it can actually publish) — proving the
  gate composition (client-review FIRST, then the six-stage chain) holds together across two
  independent sessions against one shared store, not just within one page's local state.

Test counts: **2392 / 0 / 0** `platform-ui` (baseline 2329/0/0, +63: `socialShared.test.ts`'s new
`CLIENT_REVIEW_REFUSAL`/`evaluateClientReviewState` cases, `rbac.test.ts` unaffected,
`rbac-capability-parity.test.ts` 742/742 including the three new capability pairs). `tsc --noEmit`
clean. `next build` was **not** re-run this pass (see above); `DEMO_MODE=1 npm run dev` was used for
all browser verification instead.

**Anything the spec did not answer, left as follow-ups, not silently decided:** (1) the portal's
"Post reviews" tab carries no pending-count badge — would need a new always-on fetch every portal
page load, or a `portal/overview` backend extension SMM-31 did not make; (2) no SSE topic exists for
this surface (`portal-live.service.ts`'s `PortalTopic` untouched), so the page relies on `PortalLive`'s
own unconditional idle poll rather than a pushed refresh; (3) the calendar's per-variant review fetch
is bounded by "which distinct engagements in view require client-ok" but is still an extra N reads
per page load beyond the existing account-lookup N — acceptable at this data scale, flagged as a real
(if minor) cost the same way this file already flags the roll-up's missing `network` field.

## PD — the `direct` driver (D-20) ✅ — all 5 phases merged (2026-08-21)

Second `SocialPublisher` implementation alongside Postiz, switched per capability. The only free path
that removes the AGPL zone, both fork exceptions and the inbox gap together.

| Phase | Scope | State |
|---|---|---|
| 38a | Driver skeleton + per-capability switch (defaults to `postiz`) + shared contract suite | ✅ **merged** |
| 38b | **Token custody** — encrypted at rest on the tenant wall, refresh-ahead, revocation fails closed | ✅ **merged** |
| 38c | **LinkedIn** — OAuth, org-page publish, media, `pullComments` (48h retention) | ✅ **merged** — real driver methods + real OAuth flow; wired into a live dispatch path by 38e (stale "nothing wired yet" note corrected here, 2026-08-21 closing pass — see evidence below) |
| 38d | **YouTube** — OAuth, resumable upload, 3-bucket quota, `pullComments` | ✅ **merged** — real driver methods + real OAuth flow, quota accounting; `media_upload`/`inbox_read`/`quota_probe` wired into a live dispatch path by 38e + this closing pass (stale "nothing wired yet" note corrected here, 2026-08-21 — see evidence below) |
| 38e | Flip LinkedIn + YouTube to `direct`; Postiz retained for IG/FB/TikTok | ✅ **merged (2026-08-21, senior-integrator + senior-be closing pass)** — Gap 1 (live dispatch wiring) + Gap 2 (metadata) + Gap 3 (durable quota) all CLOSED and proven live; LinkedIn's flip is real, credential-gated only (D-23); YouTube's flip was reported BLOCKED on an open dispatch-state-machine question and a related resolver-safety gap — **both CLOSED by the closing pass, see its own evidence below** — YouTube's flip is now credential-gated only too, same as LinkedIn |

⚠ 38b reverses D-5 (client tokens deliberately live *inside* Postiz so we never hold them). That is a
security decision the owner accepted with D-20, not a convenience.

**38b evidence (2026-08-20, senior-db).** Migration `202608201519_social_oauth_tokens.sql` (UTC
timestamp scheme — sequential numbering is closed above 0118): new table `social_oauth_tokens`,
THIRD RLS wall (`app_module_allowed('social')`, same as every social_* table except the portal-written
`social_post_client_reviews` — this table's writers are all social-module code, never the portal, so
the third wall is the correct, consistent choice, not the D-16 exception). Reuses `core/secret-box.ts`
(WSUX-14's AES-256-GCM app-layer vault, `enc:v1:` format) byte-for-byte — the SAME mechanism that
already seals `integration_connections.{access,refresh}_token_enc` (0033) — rather than inventing a
second scheme; the wa-chat-bot two-axis (subject × entity) OpenBao Transit crypto-shred
(`docs/runbooks/key-custody.md`) is a DIFFERENT service's answer to a different question (message
content PII) and is not wired into platform-nest at all. The shred (revocation AND expiry) NULLs both
ciphertext columns in the same statement — mirroring `core/integrations.service.ts`'s
`revokeConnection` exactly — and a new structural CHECK (`sot_shred_contract`) makes a revoked/expired
row physically incapable of holding ciphertext, not merely a convention. `resolveActiveAccessToken`
fails closed on `revoked`/`expired`/`not_found` with typed refusals, never a stale token; the
decrypted value is wrapped in a `ResolvedAccessToken` handle (mirrors `types.ts`'s `OrgHandle`
redaction — `toJSON`/`util.inspect` both emit `[redacted]`).

Refresh-ahead ships as machinery, not a live capability (this phase's own DO-NOT-DO forbids a network
call): `registerTokenRefresher(network, fn)` is an empty per-network registry 38c/38d populate;
`purgeOAuthTokens` — registered into SMM-36's seam as `registerRetentionPurger('oauth_tokens', ...)`
(`wireOAuthTokenCustody()`, called from `main.ts` alongside `wireSocialPublisher()`) — attempts a
refresh for anything due soon (no-op today, zero refreshers registered) and shreds anything that
reaches `expires_at` unrefreshed to `status='expired'`. No new job, no new schedule: it rides SMM-36's
existing per-tenant sweep and cadence. `direct` itself is still NOT registered at boot — 38b adds zero
capabilities to it (`DIRECT_CAPABILITIES` stays the empty set 38a shipped), so registering it would
only flip `resolvePublisher`'s empty-registry heuristic (`publisher_not_configured` →
`unknown_publisher`) for no behavioural gain; that distinction is preserved exactly, not revisited,
until 38c/38d give `direct` a real capability.

**The switch correction (38a's key widened to (network, capability)).** `resolvePublisherForCapability`
now takes `(orgDriver, network, capability)`; `config.social.publisher.capabilityDrivers` keys are
`network:capability` / `network:*` / `*:capability`, most-specific-wins, checked in that order. 38a's
capability-only key could not express 38e's per-network split or the P2 inbox's per-capability-within-
a-network need and is corrected before it was ever set in a real deployment (still empty by default —
still a no-op). `publisher.test.ts`'s switch suite rewritten (4 → 8 cases) to cover the exact and both
wildcard forms and their precedence.

Test counts: **367 / 0 / 0** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline measured directly by stashing this
change: **346 / 0 / 0**, matching this file's own 38a row — the ticket brief's stated 365 baseline did
not match what this worktree actually had). `tsc --noEmit` clean. `lint:postiz-deps`/
`lint:withtenants`/`lint:migration-rls`/`lint:migration-names` all green.

**Blockers/follow-ups for 38c/38d (pre-38c; superseded — see 38c's own evidence below):** neither
`storeOAuthGrant` nor any OAuth callback route exists yet — 38c/38d each build their own network's
OAuth grant flow and call `storeOAuthGrant` at the end of it, then `registerTokenRefresher(network,
fn)` with their own token-endpoint client. Both also decide (and this phase deliberately did not)
how/when `direct` first gets registered into `publisher/registry.ts` and whether
`resolvePublisher`'s empty-registry heuristic still means what it means once it is.

**38c evidence (2026-08-21, senior-integrator).** Worktree was cut BEFORE 38b (and SMM-21/23/20,
SMM-33/24 docs) landed on `main` — `oauth-tokens.ts`, the `202608201519_social_oauth_tokens.sql`
migration, `registerTokenRefresher`, `storeOAuthGrant`/`resolveActiveAccessToken` were entirely
ABSENT from this worktree at the start, exactly the "cut before a same-turn commit" hazard this file
names four times over. Confirmed via `git merge-base HEAD main` (HEAD was a strict ancestor, 16
commits behind); `git merge main` (clean fast-forward, no divergent commits) pulled everything in
before any of this ticket's own code was written.

**No migration.** Reuses 0105's `social_accounts` (the pending→connected account row) and the
already-merged `social_oauth_tokens` table byte-for-byte.

**OAuth grant flow — a STANDALONE subsystem, not `SocialPublisher.connectUrl`.** `direct.ts`'s
`connectUrl(org: OrgHandle, network, redirect)` still refuses `capability_unsupported` — the port's
signature carries neither a tenantId nor an accountId, and a real per-account OAuth flow needs both
(to create/resume the pending `social_accounts` row and mint a CSRF-bound state). Retrofitting that
into the port would have silently redefined its contract, which this ticket does not do
unilaterally — named as an architecture question for 38e/the architect, not worked around quietly.
Built instead: new `publisher/linkedin-oauth.ts` (HMAC-signed, time-boxed state —
`client-invites.ts`'s pattern reused verbatim, including its domain-separated key derivation off
`config.integrationTokenKey`; deliberately NOT DB-backed single-use like the Google OAuth state
machine — a named, considered simplification, not a silent one, given no live LinkedIn credential
exists to attack today) + new `linkedin-oauth.controller.ts` (`LinkedInOAuthController`, tenant-scoped
start/readiness reusing the EXISTING `social_account`/`connect` Cerbos action — no new policy;
`LinkedInOAuthCallbackController`, tenant-agnostic at a fixed path, mirroring
`SearchGoogleOauthCallbackController`'s three-point defence — signature-first, then Cerbos, then
LinkedIn's own single-use `code` closing the replay window the signed-but-unpersisted state does
not). Ends by calling `storeOAuthGrant` (38b's seam, used exactly as its own header promised) and
promoting the account row to `connected`, mirroring what `syncConnectorRegistry` would eventually do
for a Postiz-driven account.

**LinkedIn's real driver capabilities.** New `publisher/linkedin-client.ts` (the wire client — token
exchange/refresh, `POST /rest/posts` org-page publish, the 3-step asset upload dance
[`registerImageUpload`→`uploadImageBytes`], `GET /rest/socialActions/{shareUrn}/comments` — every
route ⚠UNVERIFIED against a live app, D-23, reasoned from the app-review dossier §4 and collected in
ONE routes table, `postiz.ts`'s own discipline). `direct.ts`'s `DIRECT_CAPABILITIES` is now
`["schedule","media_upload","inbox_read"]` — the SAME driver-wide-capability-plus-per-network-gate
shape `postiz.ts` already uses for `getQuota`/`getCreatorInfo` (advertised at the driver level,
gated per-network inside the method body, typed refusal for anything not LinkedIn), generalised to
`schedulePost`/`uploadMedia`/`listComments` now that `direct` covers a real network. **Named,
load-bearing gap for 38d**: the port's capability Set has no per-network granularity at all, and
`uploadMedia`'s own signature carries no `network` parameter — this phase's implementation always
assumes LinkedIn's asset flow, correct only by elimination until 38d adds a second real network.

**`pullComments`.** `listComments(org, integrationId, since)` is now PRESENT (not absent) on
`direct` — but `integrationId` here is redefined, deliberately and documented in `direct.ts`'s own
header, to name a POST's `providerPostId` (LinkedIn share URN), not a connected account's
integration id: LinkedIn's Community Management API has no "every comment on my page" endpoint,
only per-share. The returned `InboxItem[]` shape (`authorHandle`/`authorName`/`body`/`postedAt`)
maps directly onto `social_inbox_threads`/`social_inbox_messages`' own columns — SMM-36's purge
(`inbox-retention-job.ts`) already handles `network='linkedin'` generically via
`retention-policy.ts`'s existing documented 24h/48h row, so **no purge-side change was needed**;
SMM-15, whenever it is built, must call `listComments` once per published LinkedIn post it wants
freshly pulled, not once per connected account.

**Rate limits: modelled as unknown, never invented.** No `quota_probe` capability was added; the
dossier's own finding (Standard-tier limits are unpublished, visible only in the Developer Portal
after a live call) is respected by building nothing that would need a number.

**A missing app credential.** `checkLinkedInConnectReadiness` reuses SMM-07's exact
`platform_app_not_registered` token (per the ticket's own instruction), gated on BOTH
`hasRegisteredPlatformApp('linkedin')` (the administrative fact, `provisioning.ts`, read-only
import) AND `hasLinkedInAppCredentials()` (the env pair actually being non-empty) — either missing
refuses the same way, since neither alone is enough to start a real OAuth round trip.

**`direct` is now registered at boot, and the `publisher_not_configured` distinction IS
preserved.** `boot.ts#wireSocialPublisher` now calls `registerPublisher(createDirectDriver())` +
`registerLinkedInTokenRefresher()` UNCONDITIONALLY, ahead of the Postiz base-URL check — this is the
ticket's own call to make, and it is made by fixing `registry.ts#resolvePublisher`'s heuristic
(`anyNonDirectRegistered`, not `publishers.size===0`) rather than leaving it broken: a deployment
with `direct` registered but Postiz unconfigured still reads `publisher_not_configured` for
`resolvePublisher('postiz')`, never `unknown_publisher` — regression-pinned in `publisher.test.ts`
("registering `direct` alone still reads as publisher_not_configured"). Proven still behaviourally
INERT on every live path today, for three independent reasons stated in `boot.ts`'s own header
(0105's CHECK never writes `'direct'` to `social_publisher_orgs.driver`; the capability-driver
override map is still empty by default; and even where it were consulted, nothing on a live path
builds the `direct`-shaped `OrgHandle` `schedulePost`/`uploadMedia` need — see below).

**What 38d/38e must build against what 38c left:**
1. **The `connectUrl`/token-resolution gap** (this section's own header): whichever phase first
   routes a LIVE dispatch call through `direct` must decide how the caller resolves
   `resolveActiveAccessToken` and builds the `direct`-shaped `OrgHandle` (`.secret()` = the bearer
   token, `.orgId` = the organization URN) — that is real surgery on `provisioning.ts#openOrg` /
   `dispatch.ts`, both out of this ticket's file surface (the latter explicitly off-limits).
2. **`uploadMedia`'s missing `network` parameter** — 38d's YouTube upload will collide with this
   phase's "always assume LinkedIn" choice; the port itself may need to grow the parameter (an
   architect-level port change) or `direct.ts` needs another documented convention.
3. **The port's capability model has no per-network granularity** — `direct.capabilities` is
   driver-wide; LinkedIn/YouTube coverage differs per method today via an in-method gate, which
   works but is a per-method discipline someone has to remember for every future network, not a
   structural guarantee.
4. ~~**The OAuth state's DB-backed single-use gap**~~ **CLOSED 2026-08-23** — see "Security
   follow-ups closed" evidence block. Named, not silently decided as unnecessary, when this ticket
   shipped; a future pass wanting full parity with the Google flow's atomic consume would add a small
   state table — that pass landed.

Test counts: **413 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline measured directly in THIS worktree,
post-merge, by stashing this ticket's changes: **393 / 0 / 5** — +20 new: `linkedin-oauth.test.ts`
12, `linkedin-client.test.ts` 7, `direct.test.ts` +7, `publisher.test.ts` +1 registry regression
pin). **7 failures in `social-client-review-portal.controller.test.ts` reproduced IDENTICALLY with
this ticket's changes stashed back OUT** — a shared Cerbos-container environmental flake (verified
by reproducing it against unmodified baseline code, not asserted), not counted in either total
above and not this ticket's to fix (touching shared infra another session may depend on). `tsc
--noEmit` clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/`lint:migration-names`
all green. `test:iam-chain-alignment` green (25/25, unaffected — no Cerbos/IAM change this pass).
Full detail: `docs/modules/MODULES.md`'s social-media 0.5.8 entry.

**38d evidence (2026-08-21, senior-integrator).** Worktree was ALREADY at the 38c merge commit at
worktree-cut time (`git log -1` = `5ff9e6f merge: SMM-38c LinkedIn on the direct driver`;
`git merge-base --is-ancestor HEAD main` confirmed HEAD an ancestor of `main`) — **no merge was
needed**, flagged here per this file's own repeated cross-session-hazard rather than silently
assumed. `oauth-tokens.ts`, `linkedin-*` and `202608201519_social_oauth_tokens.sql` were present from
the start.

**The `uploadMedia` collision — resolved exactly as instructed, port widened in one place, six files
touched.** `SocialPublisher.uploadMedia(org, file)` gained a third parameter, `network: Network`
(`types.ts`): a driver serving two networks with genuinely different upload protocols cannot tell
them apart from `file.contentType`/`filename` alone (both LinkedIn and YouTube accept the same
image/video content types — no wire-level tell exists there, unlike `schedulePost`'s own
`VariantDispatch.network`). Updated: `postiz.ts` (accepts and ignores — one generic multipart
endpoint regardless of network), `mock-driver.ts` (accepts, records `state.lastUploadNetwork`),
`direct.ts` (branches on it), `publisher-contract.ts` (passes `integration.network` through). **The
ONE call site**, `dispatch.ts#resolveEngineMedia`: the variant's own `network` (already that
function's parameter) is cast `as VariantDispatch["network"]` and threaded through — the SAME cast
idiom the identical function already uses a few lines below for the `schedulePost` request. Nothing
else in `dispatch.ts` touched.

**Google OAuth — a STANDALONE subsystem, mirroring 38c's LinkedIn shape almost verbatim ("Follow
that shape" was this ticket's own instruction).** New `publisher/youtube-client.ts` (token
exchange/refresh against `oauth2.googleapis.com`, the resumable-upload protocol against
`www.googleapis.com/upload/youtube/v3/videos`, `commentThreads.list` against the Data API v3) —
**deliberately does NOT reuse `core/google-oauth/token-endpoint-client.ts`**: that file is
hard-wired to `config.google.*`, search's own SEPARATE Google Cloud app (dossier §8's app-mapping
table names "Gaiada YouTube" as its own row) — reusing it would either silently borrow search's
client credentials for YouTube's consent screen or require widening a core file outside this
ticket's surface. Also **no PKCE** (a confidential client with `client_secret`, matching
`linkedin-client.ts`'s shape — `core/google-oauth`'s PKCE use is for a different client type, named
rather than silently diverged from). New `publisher/youtube-oauth.ts` (the SAME HMAC-signed,
time-boxed state scheme 38c built — `client-invites.ts`'s pattern — with `STATE_PREFIX="yts1"`
distinguishing it from LinkedIn's `"lis1"` inside the signed input, so a token minted for one
network can never verify against the other's parser despite both deriving from the identical
domain-separated key; `checkYouTubeConnectReadiness`/`startYouTubeConnect`/`completeYouTubeConnect`/
`registerYouTubeTokenRefresher()`). New `youtube-oauth.controller.ts`
(`YouTubeOAuthController`/`YouTubeOAuthCallbackController`, mirroring
`LinkedInOAuthController`/`LinkedInOAuthCallbackController`'s three-point callback defence exactly).
`app.module.ts` registers both. Scopes requested: EXACTLY `youtube.upload` +
`youtube.force-ssl` (dossier §6.2 (a)/(b)) — never the broad `youtube` manage scope, never
analytics, never anything DM-shaped.

**YouTube's real driver capabilities — and the deliberate absence of `schedulePost`.** `direct.ts`'s
`DIRECT_CAPABILITIES` gains `quota_probe` (driver-wide); YouTube gets `media_upload`/`inbox_read`/
`quota_probe` but **NOT** `schedule` — a `videos.insert` call IS the post for this network (creates
the video resource directly), not a separate publish step referencing an already-uploaded asset the
way LinkedIn's org-page flow works, so there is no "schedule an already-uploaded YouTube video"
operation for this driver to implement. `uploadMedia`'s YouTube branch does the resumable
initiate→PUT dance and returns the created video's id. **Named, load-bearing gap**: the metadata
sent (title, privacyStatus) is MINIMAL — `title` from `file.filename`, `privacyStatus: "private"` —
because `uploadMedia`'s own signature carries no title/description field, and widening it further
than the single `network` parameter this collision required was not this ticket's call to make
unilaterally. `privacyStatus: "private"` is the SAFE default that happens to match the dossier's own
§6.3 UNVERIFIED, community-reported forced-private lock — requested deliberately, not as a
workaround for a fact this pass confirmed live.

**Quota accounting against SMM-37's three real buckets — self-tracked, not a live probe, and why
that is the honest answer.** New `publisher/youtube-quota.ts`. The caps (100 `search.list`/day, 100
`videos.insert`/day, 10,000 units/day for everything else) are CITED CONSTANTS quoted verbatim from
the dossier's own §6.4 — a genuinely different situation from the "never synthesize a cap" warning
in `types.ts` (written for Instagram's per-account, live-probeable, genuinely-variable cap): YouTube's
cap is neither variable nor probeable, since no "remaining quota" endpoint exists anywhere in the
Data API (the dossier names none) and the cap is a per-Google-Cloud-PROJECT fact, identical across
every channel this ONE deployment's ONE app touches (dossier §6.5: "100 video uploads/day across the
ENTIRE FLEET, not per client"). The `used` half is this PROCESS's own accounting — an in-memory,
per-UTC-day counter, incremented ONLY after a call this driver OBSERVED succeed (never
speculatively, since a call we cannot confirm reached Google could report a false "exhausted"
against an account nowhere near its real limit). **Named limitation, not silently accepted**:
in-memory means the counter resets on a process restart and does not share state across multiple Node
instances — both real gaps for a LIVE deployment, but nothing on a live path calls
`recordYouTubeQuotaUsage` today (the same "verified inert" property 38b's refresh-ahead registry and
38c's signed-but-unpersisted OAuth state both shipped with), so building a durable, cross-instance
counter for a capability nothing can reach live yet was left as a follow-up for 38e's live call path
to decide, not built unilaterally.

**`pullComments` — told apart from LinkedIn WITHOUT a port `network` parameter on this method, a
narrower choice than `uploadMedia`'s fix.** `direct.ts#listComments` branches on
`integrationId.startsWith("urn:li:")`: LinkedIn's entire id namespace is URN-shaped by LinkedIn's OWN
wire format (mandated by its API, not a convention this codebase invented), so this is a real,
principled tell — NOT the same class of guess `uploadMedia`'s old `file.contentType` branch would
have been (no tell exists there; both networks accept identical content types). This ticket's scope
did not name `listComments` as needing the port widened, so a real `network` parameter on that
method — the cleaner long-term answer — is left to the architect/38e/SMM-15, whichever first needs a
case this heuristic cannot cover (none among 0105's ten admitted networks collide with it today).
YouTube's branch calls `commentThreads.list` and records 1 unit against `otherUnitsToday` on success.

**No DM — modelled, not newly discovered.** `capabilities.ts`'s YouTube row already carried `dm:
false, reasons: { dm: "network" }` from SMM-05's own research pass (§A4g) — this ticket's instruction
to "model the absence with capabilities.ts's three-reasons model" was already satisfied before this
phase touched the file; verified by reading the row directly, not re-decided or rebuilt.

**A missing credential** refuses `platform_app_not_registered` (SMM-07's exact token, reused via
`checkYouTubeConnectReadiness`, gated on BOTH `hasRegisteredPlatformApp('youtube')` and
`hasYouTubeAppCredentials()`) — identical shape to LinkedIn's own gate, unchanged reasoning.

**`resolvePublisher`'s `publisher_not_configured` signal still holds** — unaffected; `boot.ts`
registers `direct` + both refreshers unconditionally, still behaviourally inert on every live path
for the same three reasons 38c's header names, unrevisited this phase (38d needed no new reason).

**No migration.** Reuses 0105's `social_accounts` (CHECK constraint already admits `'youtube'`) and
the already-merged `social_oauth_tokens` table byte-for-byte, exactly as 38c did for LinkedIn.

Test counts: **470 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** in this worktree
before any change: **420 / 0 / 5** — the ticket brief's stated "425/0/0" did not match, per this
file's own "measure your own baseline" instruction; +50 new: `youtube-client.test.ts` 16,
`youtube-quota.test.ts` 6, `youtube-oauth.test.ts` 14, `direct.test.ts` +14 [YouTube upload/quota/
listComments cases, a second YouTube-shaped contract-suite run, updated capability-set and
`uploadMedia`-signature assertions]). The full run AND the 8 new/changed files re-run ALONE
afterward (163/163) to rule out the shared-test-Postgres phantom-failure class this file names — both
green. `tsc --noEmit` clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/
`lint:migration-names` all green (no migration this phase). `test:iam-chain-alignment` green (25/25,
unaffected — no Cerbos/IAM change). Full detail: `docs/modules/MODULES.md`'s social-media 0.5.9 entry.

**What 38e must build against what 38d left, in addition to what 38c already named:**
1. Everything 38c's own "what 38d/38e must build" list already named (the `connectUrl`/token-
   resolution gap on `provisioning.ts#openOrg`/`dispatch.ts`; the port's per-network capability
   granularity, still a per-method discipline; the OAuth state's DB-backed single-use gap) — all
   still open, now for TWO networks instead of one.
2. **YouTube's `uploadMedia` metadata gap** — real video title/description drawn from the variant's
   own body has nowhere to travel through the current `uploadMedia(org, file, network)` signature;
   38e (or a dedicated pass) must decide whether that needs a fourth parameter, a different seam, or
   stays filename-derived.
3. **The quota counter's durability** — in-memory, per-process, resets on restart, does not share
   state across instances. Fine while nothing live increments it; NOT fine the moment 38e's dispatch
   wiring makes a real upload call reachable. A future pass should decide a table vs. a shared cache
   before that day, not after a real upload silently exceeds the 100/day wall unnoticed.
4. **`listComments`'s URN-prefix heuristic** — works for LinkedIn vs. YouTube today; the FIRST future
   network whose id namespace also happens to start with `urn:li:` (none exists) or otherwise
   collides would need the port's `network` parameter added to this method for real, not another
   heuristic layered on top.

**38e evidence (2026-08-21, senior-integrator).** Worktree was BEHIND main (`git log -1` =
`5ff9e6f merge: SMM-38c LinkedIn on the direct driver`; `git merge-base --is-ancestor HEAD main`
confirmed it) — `git merge main` (clean fast-forward) pulled 38d's YouTube work in before any of this
pass's own code was written; flagged per this file's own repeated cross-session-hazard note.

**Gap 1 (the crux) — CLOSED with a NEW resolver, `provisioning.ts#resolveDispatchOrgHandle(tenantId,
chain, capability)`, not a widened `openOrg`.** Design decision, made deliberately rather than
defaulted into: `openOrg` stays synchronous and DB-free (correct for Postiz's env-resolved API-key
alias, and every EXISTING Postiz caller — `verify`, `syncConnectorRegistry`, `initiateAccountConnect`
— keeps calling it exactly as before); the new resolver is a SEPARATE function, consulted only by
`dispatch.ts`'s two capability-switchable operations. It calls `resolvePublisherForCapability`; when
the result is not `direct`, it builds the IDENTICAL Postiz-shaped handle `openOrg` always built; when
it IS `direct`, it resolves the account's live OAuth grant through `oauth-tokens.ts#resolveActiveAccessToken`
(fail-closed on revoked/expired/missing) and builds the `direct`-shaped handle — `.secret()` the
resolved bearer token, `.orgId` LinkedIn's org URN drawn from 38c's OWN existing config constant
(`config.social.direct.linkedin.organizationUrn`), sufficient because a `direct`-routed LinkedIn
connect is already own-brand-only (OQ-3) — no schema column needed, no new design surface. YouTube's
`org.orgId` stays unused, per 38d's own header. `dispatch.ts#dispatchApprovedPublish` now calls this
resolver TWICE — once for `media_upload` (only when the variant carries attachments, preserving the
"never acquire an upload round trip it never needed" AC) and once for `schedule` — replacing the
single `openOrg(chain.org)` call 38a–38d left in place. Proven LIVE, not merely asserted:
`dispatch.test.ts`'s new (D1)–(D4) drive a REAL `social_oauth_tokens` row through a REAL
`resolveActiveAccessToken` call and a SECOND registered driver (key `"direct"`) actually receiving the
resolved token — (D1) no override ⇒ the default stays inert, both calls land on the SAME driver every
other network uses; (D2) both capabilities overridden ⇒ both calls land on `direct` with the real
token and the configured org URN; (D3) only `media_upload` overridden ⇒ PER-CAPABILITY routing is
real, not per-network (upload reaches `direct`, schedule still reaches the org's own driver) — the
exact property the (network, capability) key was widened for in 38b and had never been exercised on a
live path until now; (D4) a revoked grant fails closed — `dispatch_error` carrying
`oauth_token_revoked`, the approval still consumed (design's own `neverAutoRetry` doctrine), never a
crash, never a stray publish.

**A gap FOUND while wiring Gap 1, fixed at the source (`linkedin-oauth.ts`/`youtube-oauth.ts`, both
under this ticket's own `publisher/*` surface), not relaxed generically.**
`completeLinkedInConnect`/`completeYouTubeConnect` (38c/38d) promoted an account to `connected`
WITHOUT ever setting `postiz_integration_id` — and `provisioning.ts#assertDispatchChain`'s generic
`account_not_connected` gate refuses ANY account whose `postiz_integration_id` is NULL, regardless of
driver. Every `direct`-connected account would have failed this gate before ever reaching
`resolveDispatchOrgHandle`, silently, until this pass's own dispatch test happened to need a
non-NULL value and surfaced it. Fixed with a self-describing, non-NULL sentinel
(`'direct:linkedin'`/`'direct:youtube'`) — never mistaken for a real Postiz-issued opaque id, which
never contains a `:` — rather than relaxing the shared, generic gate for one driver. Regression-pinned
in both `linkedin-oauth.test.ts` and `youtube-oauth.test.ts` (asserted on the existing
start→complete test's own connected-row read, not a new describe block).

**Gap 2 — YouTube's `uploadMedia` metadata channel — CLOSED, additively.** `SocialPublisher.uploadMedia`'s
`file` parameter gains two OPTIONAL fields, `title`/`description` (`types.ts`) — on the SAME bag
`network` joined in 38d, so `postiz`/the mock/LinkedIn's branch simply ignore what they do not use.
`dispatch.ts#resolveEngineMedia` (the one call site) derives both from the variant's own `body` for a
YouTube-network upload via a new `youtubeUploadMetadata()` helper: the body's first line becomes
`title` (truncated to 100 chars — YouTube's commonly-documented limit, ⚠UNVERIFIED, D-23, a
defensive cap regardless), the full trimmed body becomes `description`. `direct.ts`'s YouTube branch
prefers a real supplied title, falling back to the filename ONLY when none was sent or it was
blank/whitespace-only — never silently overriding a real one. Pinned in `direct.test.ts` (a real
title/description sent verbatim to the wire; a blank title still falls back; the PRE-EXISTING
filename-fallback case is untouched and still passes).

**Gap 3 — the quota counter's durability — CLOSED with an injectable seam, not a hard rewrite.** New
`YouTubeQuotaStore` interface (`youtube-quota.ts`): `defaultYouTubeQuotaStore()` wraps the ORIGINAL
38d module-level functions byte-for-byte — every existing test in that file, including
`resetYouTubeQuotaUsage()`'s own seam, needed ZERO changes, proven by re-running them verbatim, not
merely claimed. `createDbYouTubeQuotaStore()` is the new durable implementation: a GLOBAL table
(`social_youtube_quota_usage`, new migration `202608210411_social_youtube_quota_usage.sql`) with NO
tenant_id and NO RLS — the SAME D-4 reasoning `social_platform_apps` already carries (the 100-upload/
day cap is a per-Google-Cloud-PROJECT fact, shared across every tenant's every channel, never a
per-tenant one; a tenant-walled table would UNDERSTATE the real, shared exposure). `record()` is a
single atomic `INSERT ... ON CONFLICT (usage_day) DO UPDATE SET col = col + EXCLUDED.col` — proven
under REAL concurrency (10 parallel increments summing to exactly 10, not merely asserted from the SQL
text) — never a read-then-write, so two Node instances recording concurrently add up correctly.
`direct.ts`'s `DirectDriverOptions` gains `quotaStore?: YouTubeQuotaStore` (default: the in-memory
wrapper, so every existing test — none of which passes this option — is unaffected); `boot.ts` wires
`createDbYouTubeQuotaStore()` for the real app only.

**The flip's config shape, and the no-config default STAYS INERT — proven, not merely claimed.** No
default value was added to `config.social.publisher.capabilityDrivers`; it ships exactly as empty as
38a left it, for every network including LinkedIn and YouTube. `resolvePublisher`'s
`publisher_not_configured` signal (`anyNonDirectRegistered`) is untouched, unregressed, and every
existing `publisher.test.ts` case (63 of them) still passes byte-for-byte with zero edits — the
concrete proof this file's own update protocol asks for, not an assertion that it "should" still
hold. The RECOMMENDED override for a deployment that has cleared LinkedIn's credential gate (D-23,
staging) is `linkedin:schedule=direct,linkedin:media_upload=direct,linkedin:inbox_read=direct` —
deliberately excluding every `youtube:*` key, for the reason below.

**YouTube's flip is reported as an open architecture question, not silently wired around.** Routing
`youtube:media_upload` to `direct` today would upload a REAL video via a real dispatch call and then
have `dispatch.ts` unconditionally attempt a SECOND step — `schedulePost` — which `direct.ts` refuses
`capability_unsupported` for YouTube by design (a `videos.insert` call IS the post; there is no
separate publish step for this network in this driver's shape, per 38d's own header). The result
would be an approval spent, a stray video already live upstream, and a variant row recorded `failed`
— the exact "a false negative that hides a real side effect" class this program's tests are built to
catch. This is a dispatch-STATE-MACHINE question (how a network whose publish terminates at
`uploadMedia` gets represented in a flow built around "upload then schedule"), not a token-resolution
one, and this ticket does NOT decide it unilaterally — named in `provisioning.ts#resolveDispatchOrgHandle`'s
own header, the capability inventory's new section, and here, consistently, rather than guessed at in
one place and left stale in another. **This is why 38e is 🟡 partial, not ✅**: LinkedIn's flip is
real end to end (credential-gated only, D-23); YouTube's is principle-only for TWO independent
reasons — the same credential gap, AND this unresolved dispatch-flow question.

**Capability inventory updated (§PD's own exit criterion for this phase).**
`docs/modules/social-capability-inventory.md`'s new "Driver per capability" section records, for
every (network, capability) pair this wave built something for: which driver serves it TODAY (always
Postiz or nothing — the default never changed), which one COULD serve it if flipped, and exactly what
stands between "could" and "does" — naming the credential gap and YouTube's dispatch-flow gap as two
INDEPENDENT reasons rather than collapsing them into one "not live yet" sentence.

Test counts: **483 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** in this worktree
by stashing this pass's changes: **470 / 0 / 5** — matching `main`'s own stated 475/0/0-as-three-numbers
figure exactly [470 passed + 5 skipped = 475]; +13 new: `dispatch.test.ts` +4 [(D1)–(D4)],
`direct.test.ts` +3 [real title/description, blank-title fallback, injectable quota store],
`youtube-quota.test.ts` +6 [the store-seam unit case + 5 durable-store DB cases, including the
concurrent-increment proof]; `linkedin-oauth.test.ts`/`youtube-oauth.test.ts` each gained an
ASSERTION on an existing case, not a new `it()`, so 0 added to either file's count while still
regression-pinning the `postiz_integration_id` fix). The full changed/new-file set (6 files, 117
tests) re-run ALONE afterward — green, ruling out the shared-test-Postgres phantom-failure class this
file names. `tsc --noEmit` clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/
`lint:migration-names` all green (127 migrations scanned by the linters; 128 files physically present
in the directory — one non-`.sql` file in the directory is excluded by the linters' own glob,
unrelated to this pass). `test:iam-chain-alignment` green (25/25, unaffected — no Cerbos/IAM change
this phase). Full detail: `docs/modules/MODULES.md`'s social-media 0.5.10 entry.

**What SMM-15 (P2 inbox sync, still unbuilt) must build against what this phase leaves:** nothing new
beyond what 38c/38d already named — neither `inbox_read` capability was flipped in the shipped
default, so `listComments`'s own keying-by-`providerPostId` note stands unchanged.

**What the architect must decide (as of 38e itself) — named, not guessed at:** the dispatch-state-machine
representation for a network whose publish terminates at `uploadMedia` rather than a separate
`schedulePost` step (YouTube, today; potentially a future network). Until decided,
`youtube:media_upload` must never be set to `direct` in `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` on any
deployment, credentialed or not — a config value nothing currently prevents an operator from setting,
which is itself worth the architect's attention (should `resolvePublisherForCapability` refuse an
override the dispatch flow cannot safely honour, rather than accepting any registered driver name?
Not decided here — this ticket's own file surface and mandate stop at reporting the question).

**Both of the above are CLOSED by the 38e closing pass (2026-08-21, senior-be) — see its own evidence
block immediately below.** Worktree state, before touching anything: `git log --oneline -1` =
`d59c730 fix(authz): /api/rollups authorizes against the caller's root, not no tenant at all`;
`git merge-base --is-ancestor HEAD origin/main` confirmed the worktree was ALREADY current with
`origin/main` — no merge was needed, stated rather than assumed, per this file's own repeated
cross-session-hazard note. Every file the ticket named as load-bearing
(`publisher/youtube-client.ts`, `publisher/youtube-quota.ts`,
`provisioning.ts#resolveDispatchOrgHandle`) was present and current at cut time.

**The upload-terminal gap — CLOSED with a driver-declared property `dispatch.ts` consults, chosen
over a documented no-op `schedulePost`, and why.** Both shapes were weighed, per the ticket's own
instruction. A no-op `schedulePost` for YouTube would still require `dispatch.ts` to resolve a SECOND
(network, capability) pair after the upload, open a second OTel span for an operation that does
nothing, and — critically — if `schedule` were ever misconfigured to point at a driver that does not
cover YouTube (exactly the override-safety gap below), the refusal would arrive AFTER a live video
already exists upstream, the same "false negative hiding a real side effect" class this program's
tests exist to catch. The declared-property shape avoids ever asking the question: new optional
`SocialPublisher.isUploadTerminalFor(network): boolean` (`types.ts`) lets a driver state, per network,
that its `uploadMedia` IS the publish — no distinct step exists to call. `direct.ts` declares this
`true` for YouTube only (backed by a new `UPLOAD_TERMINAL_NETWORKS` set), `false`/absent for LinkedIn
(whose `media_upload` genuinely registers an asset a LATER `schedulePost` references) and every other
network. `dispatch.ts#dispatchApprovedPublish` checks it immediately after `resolveEngineMedia`
returns — only when media was actually uploaded, mirroring the existing "a text-only variant never
acquires an upload round trip" AC — and when true, takes engineMedia's own last entry's `id` as
`providerPostId` and skips `resolveDispatchOrgHandle(..., "schedule")`/`schedulePost` ENTIRELY. **The
single-transaction stamp still holds, unmodified**: `stampDispatchOutcome` (SMM-10) runs exactly as it
always has, fed `dispatched = {providerPostId: term.id}` instead of `schedulePost`'s return value —
one UPDATE, both columns, only after the network call (the upload) was actually attempted. Proven
live in `dispatch.test.ts`'s new (E1)–(E3), using a SECOND registered mock (not the real `direct`
driver — `direct.test.ts` already proves YouTube's real wire shape; this proves ROUTING/STAMPING, the
split `mock-driver.ts`'s own header already draws) configured to declare the same facts the real
driver declares: (E1) `youtube:media_upload=direct` ALONE dispatches successfully, `schedulePost`
reached on NEITHER driver, `provider_post_id` is the upload's own returned id verbatim, status
`queued`, approval consumed; (E2) ALSO setting `youtube:schedule=direct` changes nothing — the
terminal check short-circuits before `schedule` is ever resolved, proving the misconfiguration is
simply never reached; (E3) `youtube:schedule=direct` WITHOUT a `media_upload` override still refuses
(via the override-safety gap below), proving the two fixes are independent, not each secretly
depending on the other.

**The override-safety gap — CLOSED with a driver-declared coverage map, never a hand-maintained
deny-list.** New optional `SocialPublisher.coversNetworkCapability(network, capability): boolean`
(`types.ts`) — the precedent named in the ticket brief (`DIRECT_CAPABILITIES` / `capabilities.ts`'s
three-reasons model: "a driver that declares what it can serve beats a list someone must keep in
sync"), applied to the ROUTING question rather than the account-facing one. Backed on `direct.ts` by
ONE new map, `NETWORK_CAPABILITIES` — LinkedIn: `schedule`/`media_upload`/`inbox_read` (not
`quota_probe` — unpublished rate limits, unchanged reasoning); YouTube: `media_upload`/`inbox_read`/
`quota_probe` (not `schedule` — see the gap above) — the SAME map both this new port member AND the
pre-existing in-method runtime gates (`refuseNetworkNotCovered`) read from, so a future network or
capability needs exactly one new entry, never two lists that could drift apart.
`registry.ts#resolvePublisherForCapability` consults it AFTER the existing "is this driver name
registered" check (so `unknown_publisher` still fires first, unchanged) and refuses EAGERLY, with the
existing `capability_unsupported` code (no new refusal token — the ticket's own reuse-over-invention
discipline), the moment a configured override names a (network, capability) pair the resolved driver
does not cover — before any network call, not after one. **Made data, not a crash, per the ticket's
own instruction**: the refusal is a typed `SocialPublisherError`, not an exception a caller has to
guess the shape of. Absent method (Postiz, the mock) ⇒ no per-network restriction at all — the SAME
"absent capability member means nothing to check" shape `listComments`/`sendReply`/`getCreatorInfo`
already use — so every existing deployment (which registers only Postiz/the mock) is provably
unaffected. Proven in `publisher.test.ts`: TWO pre-existing switch-suite cases were REWRITTEN, not
just left alone, because they happened to exercise a (network, capability) pair `direct` does not
actually cover (`linkedin:*` applied to `quota_probe`; `*:schedule` applied to `youtube`) — both now
assert the eager refusal instead of a silent resolve that 38e itself had left silently unsafe; the
underlying property each test was ACTUALLY there to prove (network-wildcard/capability-wildcard
precedence) was re-pointed at `media_upload`, which both LinkedIn and YouTube genuinely cover, so the
tests still prove precedence rather than accidentally proving coverage. A NEW case proves the
inverse: a driver with no `coversNetworkCapability` declared at all is never refused, even for a
(network, capability) pair nothing models.

**A stale comment corrected at the source, not left to mislead the next reader** (this file's own
recurring defect class §4b). `provisioning.ts#resolveDispatchOrgHandle`'s own header used to name
YouTube's flip as unsafe and deliberately excluded; `direct.ts`'s file header carried the matching
claim in its "WHO BUILDS THAT HANDLE" section. Both corrected in place to describe the closed gap and
point at the fix, rather than left standing next to code that now contradicts them.

**Inertness, `publisher_not_configured`, and `unknown_publisher` — all three invariants proven still
held, not merely asserted.** No default value was added to `config.social.publisher.capabilityDrivers`
— it ships exactly as empty as every prior phase left it. `resolvePublisher`'s
`publisher_not_configured` signal (`anyNonDirectRegistered`) is untouched — no test needed rewriting
for it. `unknown_publisher` for an override naming an unregistered driver is untouched — the coverage
check runs strictly AFTER the registration check, so a name this deployment does not run still
refuses `unknown_publisher`, never `capability_unsupported`, never a silent fallback. Both new port
members are OPTIONAL, so Postiz/the mock needed zero lines changed, and 100% of the pre-existing
suite (except the two rewritten cases named above, whose rewrite was the point) passes byte-for-byte.

**Is `youtube:media_upload=direct` now safe to configure, or still refused — and which is correct?**
**Safe, and that is the correct answer.** Both of 38e's own stated blockers for this SPECIFIC
combination are resolved: the dispatch-flow danger (a stray live video plus a doomed second publish
step) is eliminated by construction (the schedule step is never reached), and the resolver no longer
blindly trusts a config string it has no way to verify. What remains is `youtube:schedule=direct`
NAMED ALONE (without a `media_upload` override) — and THAT is correctly refused, eagerly, by the
override-safety gap, because `direct` genuinely never implements a schedule step for YouTube and never
will (the upload-terminal gap is not a workaround for a missing feature; it is the correct
representation of a network whose API has no such step). The recommended override for a
credential-cleared deployment (D-23, staging) is therefore now
`linkedin:schedule=direct,linkedin:media_upload=direct,linkedin:inbox_read=direct,youtube:media_upload=direct,youtube:inbox_read=direct,youtube:quota_probe=direct`
— `youtube:schedule` correctly absent, not because of caution but because there is nothing for it to
name.

Test counts: **494 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** in this worktree by
stashing this pass's changes: **483 / 0 / 5** — matching `main`'s own stated 38e figure exactly; +11
new: `dispatch.test.ts` +3 [(E1)–(E3)], `direct.test.ts` +7 [4 `coversNetworkCapability` cases, 3
`isUploadTerminalFor` cases], `publisher.test.ts` +1 [the absent-method case; two existing cases
rewritten in place, not counted as new — see above]). The full `src/modules/social` suite (27 files)
re-run ALONE afterward, and each of the three touched test files re-run alone individually too, to
rule out the shared-test-Postgres phantom-failure class this file names — all green. **One real
regression was found and fixed during this pass's own verification, not shipped**: a new
`direct.test.ts` case reused the shared module-level `unreachableFetch` mock with a non-empty approval
id; because it was inserted ahead of a pre-existing test in file declaration order, its call polluted
that earlier test's own `expect(unreachableFetch).not.toHaveBeenCalled()` assertion — a NEW,
generalizable defect class (recorded below), fixed by giving the new case its own locally-scoped stub
rather than reusing a shared, stateful mock. `tsc --noEmit` clean.
`lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/`lint:migration-names` all green (still 127
migrations — no migration this pass). `test:iam-chain-alignment` green (25/25, unaffected — no
Cerbos/IAM change this phase). Full detail: `docs/modules/MODULES.md`'s social-media 0.5.11 entry.

**Anything the spec did not answer:** whether a future third network with a similarly split
upload/schedule shape should widen `listComments`'s own id-namespace heuristic (branching on
`urn:li:` today) to a real `network` parameter on that method — 38d's own named follow-up, still
open, untouched by this pass since no such network exists among 0105's ten admitted networks yet.

**38a evidence (2026-08-20, senior-integrator):** no migration, no Cerbos change, no `main.ts`
change — **verified inert**: every capability still resolves to `postiz`. Built:
`publisher/direct.ts` (the skeleton — every port member refuses `capability_unsupported` naming the
op and the phase; `capabilities` is an EMPTY `Set`; `listComments`/`sendReply` stay ABSENT, matching
Postiz's own "absent, not throwing" discipline for its zero-inbox gap); `publisher/registry.ts`'s
new `resolvePublisherForCapability(orgDriver, capability)` (the per-capability switch, a NEW
dimension on `resolvePublisher`'s existing per-org resolution — falls through to
`resolvePublisher(orgDriver)` when `config.social.publisher.capabilityDrivers` has no entry for that
capability, which is the entire inertness argument: no flag, just an empty map producing the exact
call every caller already makes); `config.ts`'s new `capabilityDrivers` (parsed from
`SOCIAL_PUBLISHER_CAPABILITY_DRIVERS`, empty by default); `types.ts`'s `PublisherKey` widened to
admit `'direct'` (type-level only — 0105's `driver` CHECK constraint still admits only
`'postiz'`/`'mixpost'`, so `'direct'` never enters that column in this phase, by design: the switch
lives in config, not the row). `publisher-contract.ts` (new): the port's behavioural contract
pulled out of one driver's test file into `runPublisherContractSuite(label, {build, integration?})`,
run against `postiz`, the mock, and `direct` — a capability gap asserts the typed refusal, never a
skip (the ticket's own instruction, applied literally).

**Deliberately NOT done, and why:** `direct` is not registered in `main.ts`/`boot.ts`. Registering
it unconditionally would make the driver registry non-empty even with `SOCIAL_POSTIZ_BASE_URL`
unset, silently flipping `resolvePublisher`'s refusal from `publisher_not_configured` to
`unknown_publisher` for every org in an otherwise-unconfigured deployment — a live-behaviour change
this phase's own acceptance bar forbids. Left to 38b+, whichever phase first gives `direct` a real
capability worth reaching; that phase also owns revisiting `resolvePublisher`'s empty-registry
heuristic if it needs to.

Test counts: **346 / 0 / 0** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (was 318/0/0, +28: `direct.test.ts` new, 12;
`publisher.test.ts` +16 — the shared suite against `postiz`/mock, 6 each, plus 4 for the switch).
`tsc --noEmit` clean. `lint:postiz-deps`/`lint:withtenants`/`lint:migration-rls`/
`lint:migration-names` green. `test:iam-chain-alignment` green (25/25, unaffected — no IAM/Cerbos
touched). Full detail: `docs/modules/MODULES.md`'s social-media 0.5.5 entry.

**What 38b must build against what 38a left:** a token table on the tenant wall (senior-db's call,
per this ticket's own DO-NOT-DO list) plus the encryption/refresh-ahead/revocation machinery; once
any single capability is real, that phase decides how `direct` gets registered at boot and whether
`resolvePublisher`'s `publishers.size === 0` heuristic still means what it means today.

## P3 — content ops ⬜

| # | Ticket | State | Note |
|---|---|---|---|
| SMM-19 | Brand-voice RAG + AI drafting, cross-client leak test | ✅ | |
| SMM-20 | Asset attach only; `ai.imageGen` ships inert and names why | ⬜ | |
| SMM-21 | Metrics → `social_metrics_daily`, nightly flow, Analytics tab | ✅ **merged** | backend + frontend DEV-VERIFIED, evidence below; `main.ts` registration **CONFIRMED landed** 2026-08-20 by the SMM-33/24 docs pass (this row previously said "still pending merge" — stale, corrected: `main.ts` now imports and calls `startMetricsPullLoop`) |
| SMM-20 | Asset attach only; `ai.imageGen` ships inert and names why | ✅ | files/Drive/Studio `creative_assets` attach, browser-driven; see evidence below |
| SMM-21 | Metrics → `social_metrics_daily`, nightly flow, Analytics tab | ⬜ | |
| SMM-22 | X metering live: stop-loss in dispatch **and** precondition, usage panel | ✅ **merged** | backend DEV-VERIFIED against live Postgres (591/0/5); usage panel UI **unit/type-checked only, NOT browser-driven** — see evidence below |
| SMM-23 | Reports: snapshot + AI narrative → approve → render → Drive | ✅ | backend DEV-VERIFIED against live Postgres + Redis + a real sidecar round trip, evidence below |
| SMM-24 | Docs/registration, BFF rows, toolkit entry, MAP regen, AGPL source-offer footer | ✅ **docs closed** 2026-08-20 | toolkit entry **already complete** (`deptToolkits.ts`, all four routes); MODULES/CHANGELOG current; two stale doc claims corrected 2026-08-20; `docs/FRONTEND-BFF-CONTRACT.md` §19 gained the missing dispatch-endpoint row, the webhook-intake row, and the two SMM-21 metrics rows, each verified against the controller code read directly. **The AGPL source-offer itself was NOT built as of this pass** — confirmed then (no footer surface anywhere in the staff console) and a placement recommended, not built. **Closed 2026-08-21 by senior-uiux** — see the (now-closed) gap entry below for the placement decision, the exact copy, and the browser evidence |
| SMM-25 | Full-stack e2e + Playwright suite + DEMO_MODE fixtures | 🟡 partial (DEV-VERIFIED for its buildable half) | DEMO_MODE fixture landed in SMM-14 (extended by SMM-12/18/22/27); the committed Playwright console suite (`e2e/social-console.spec.ts`, new `social` project) landed this pass — 13/13, driven twice (parallel + serial); live full-stack e2e remains genuinely undrivable — every platform app credential is empty and app reviews are deferred to staging (D-23), so no live dev stack exists for anyone to drive today. See evidence below |
| SMM-33 | Capability inventory + eval register | ✅ **both named gaps CLOSED** 2026-08-21 | golden-case table (SMM-14, proof of P1) stands; the companion registry (`docs/modules/social-capability-inventory.md`) named two structural gaps 2026-08-20; **both closed in code 2026-08-21 (senior-be)** — see evidence below. **21 MCP tools** now (was 18; the three new client-review tools), the group's own read/request/withdraw declared, the portal decide confirmed to stay undeclared; the post-status webhook (and its shared safety-poll sibling) now writes an honestly-attributed (`actor_id NULL`) `work_activity` row |

**SMM-25 evidence (2026-08-23, qa).** Worktree was current at cut time (`git log --oneline -1`
matched `main`'s tip through SMM-27's merge; `best-time.ts`/`InboxWorkspace.tsx` both present) —
stated rather than assumed, per this file's own repeated cross-session-hazard note.

**The honest scope reduction, stated plainly rather than silently narrowed.** The addendum's row
asks for three things: full-stack e2e on the live dev stack, a Playwright console suite, and
DEMO_MODE fixtures. The fixtures already landed (SMM-14, extended by SMM-12/18/22/27) and the live
half is not buildable by anyone today — every platform app credential in the estate is empty and
app reviews are deferred to staging (D-23), so there is no live dev stack to point a browser at.
**This pass delivers the DEMO_MODE Playwright suite only**, and says so rather than describing
DEMO_MODE coverage as live verification.

**New `platform-ui/e2e/social-console.spec.ts`** (13 tests) + a new `social` project in
`playwright.config.ts` (self-contained logins — platform_admin/manager-tier, plain `member`, and
the demo client-portal contact — no dependency on the `chromium` project's stored session, same
reasoning as the `portal`/`personas`/`pm-unified` projects' own headers). Covers all four department
routes (`calendar`/`composer`/`inbox`/`analytics` under `dept-4`) plus the client-review portal
list+detail pages.

**Every honest-absence state from the ticket's own table, covered or named as a gap:**
- `insufficient_evidence` best-time chip — covered, and distinguished from `suggested` (quotes an
  hour + UTC), `not_yet_computed`, and `unsupported` (all four now reachable — see the fixture note
  below).
- `unsupported` vs empty inbox — the fixture gap this ticket found: NO seeded post variant targeted
  `soc-acc-tiktok-1` (the one account `BEST_TIME_SEED` already marks `unsupported`), so the
  Composer could never actually render that fourth state. Closed with one new fixture post/variant
  (`soc-post-10`/`soc-var-11`, `demoSocial.ts`), additive only — no existing seed touched.
- triage `purged` — covered as a compliance fact: chip text, its "not a failure" caption, the row's
  own "(content purged)"/"Unknown" wording, and a computed-style check proving it is NOT rendered
  in the critical/red family.
- triage `unclassified` vs `unavailable` — covered as an actual CSS distinction
  (`font-style: italic` vs `normal`), not just two different strings, per the ticket's own "assert
  the distinction" instruction.
- quota unknown vs not-modeled vs real — covered, three exact strings, including the at-cap
  (25/25) case staying "known" rather than flipping to some fourth state.
- `source_content_purged` — covered through the real send-preconditions read (fail-closed-on-unknown).
- KPI omitted vs zeroed — covered: an em-dash cell alongside a real number in the SAME row (proves
  it isn't a blanket dash), plus a whole account (`soc-acc-ig-2`, never pulled) asserted ABSENT from
  the per-account tables rather than rendered as a zeroed section.
- `platform_app_not_registered` — **named as unreachable in DEMO_MODE today, not forced.**
  `InboxUnavailableNotice` (the only UI surface that renders this token's copy) is gated on
  `status.data.inboxSurface !== "available"`, and `demoSocial.ts`'s own `publisher/status` route
  hardcodes `inboxSurface: "available"` **on purpose** (that file's own comment: DEMO_MODE exists to
  prove the triage UI renders, not to reproduce D-23's "none" steady state). Flipping that default
  would silently hide every triage-chip/SLA/reply-gate scenario this suite (and SMM-18's own
  browser pass) depends on being visible — the fix would need a query-param toggle threaded through
  `lib/social.ts`'s `getPublisherStatus` and the inbox page itself, both off-limits to this ticket's
  file surface. Unit coverage already exists (`socialShared.test.ts`, cited by name in that file).
  Reported rather than papered over — a real, if narrow, gap for whoever next touches that surface.
- The Calendar/Composer pages' own `AccessDenied` (403) path is **likewise unreachable in
  DEMO_MODE** — `demoFixtures.ts`'s dispatcher never returns a 403 for `/modules/social/*`
  regardless of caller role (no RBAC enforcement in the fixture layer at all for those two pages;
  unlike the Inbox page, which gates locally via a direct `can(me, "social.inbox.read", tenant)`
  check BEFORE any network call — that one IS real and IS the suite's RBAC negative control). The
  suite instead proves the write-affordance is correctly hidden for a `member` (no `NewPostForm` on
  Composer) — the honest ceiling of what DEMO_MODE can prove for those two pages.

**Distinctions, not presence — how each was actually asserted:** every table-row assertion above
compares the SPECIFIC wording/style two adjacent states would collapse into if a future change
broke the distinction (e.g. `toHaveCSS("font-style", …)` for triage, an explicit
`.not.toBe("0")`/`.not.toBe("—")` pairing for every omitted-metric check, a computed-color check
that the purged chip is NOT the critical-red RGB), never a bare "something rendered" check.

**Drag-to-reschedule** (`soc-post-3`, two approved variants): the native HTML5 DnD is driven with
`locator.dragTo()`, and the blocking `confirm()` is captured via `page.once("dialog", …)` — the
message is asserted to name the exact count ("2 approved variants" / "discard 2 existing
approvals" / "drops back to draft"), then **dismissed**, and the post is proven to have NOT moved
(reload + re-check). The confirm-and-commit path is not separately re-driven (the cancel path
already proves the warning fires before any write; SMM-12's own evidence already covers the commit
path with the resulting banner).

**Negative control (SMM-24):** `SourceOfferNotice` (role="note", "Open-source notice") is present
on Social Media (`dept-4/calendar`) and absent on Web Dev (`dept-1/projects`) — both assertions in
one test, so a regression that made the footer console-wide (or vanish entirely) fails on the same
run either way.

**Fixture added, `globalThis`-pinned:** `soc-post-10`/`soc-var-11` in `demoSocial.ts`'s
`POSTS_SEED` (the tiktok best-time gap above) — read-only relative to the existing pinned `STORE`
object, appended to the same array that store already wraps, so it inherits the existing pinning
with no new mutable state of its own.

**No real product defect found.** Every one of the 13 tests' first-pass failures (6 distinct
locator bugs, caught and fixed before this count) was a test-authoring precision issue — three
strict-mode collisions from scoping a `getByText`/`getByRole` too broadly across a page that
legitimately renders the same label twice for two different reasons (once as a compliance-disclaimer
caption AND once as a live triage chip; once as a status pill AND once as a plain-text caption on
the portal's decided-reviews row; once as a stage-code badge AND once inside an unrelated sentence
containing the same substring), one page-title collision (a post literally titled "…now stale"
defeating a page-wide regex), and one genuine test-isolation bug in THIS suite (two tests racing on
the same shared-`globalThis` demo row under `fullyParallel`, fixed with `test.describe.configure({
mode: "serial" })` rather than a blanket `.first()` that would have hidden a real collision if one
ever existed). None of the six fixes weakened an assertion's meaning — each was re-scoped to name
which of two legitimately-duplicated elements it meant. Re-run twice after fixing (parallel, 8
workers, 32.6s; then alone, 1 worker, 49.4s) — 13/13 both times, ruling out both the
shared-globalThis-store phantom-failure class and ordinary flakiness.

**Environment note for the next seat:** this worktree had no `node_modules` and no `SESSION_SECRET`
set — `npm ci` plus `SESSION_SECRET=<anything, 32+ chars>` in the shell that spawns `npx playwright
test` (not just `DEMO_MODE`, which `playwright.config.ts`'s `webServer.env` already sets) are both
required before `next dev` will serve `/login` at all; its absence surfaces as every `loginAsPersona`
call timing out on `waitForURL`, not as a build error, which reads confusingly like a broken login
flow rather than a missing env var.

**What remains unverifiable until credentials exist:** a real publish to any live network, a real
Postiz round trip, a real LinkedIn/YouTube `direct`-driver dispatch, and the true steady-state
`platform_app_not_registered` inbox panel in a browser — all D-23, all named rather than guessed at.

**SMM-33 + SMM-24 evidence (2026-08-20, medior, docs-only pass).** Started from a worktree cut before
`main` had SMM-21's merge (`9a5a8f5`); confirmed a clean fast-forward (`git merge-base --is-ancestor
HEAD main`) and took it before reading any code, per this file's own "worktrees can be cut before a
commit made in the same turn" hazard — otherwise this pass would have built the inventory against a
tree missing `metrics-job.ts` entirely. Full inventory, its gaps, and how it was built:
`docs/modules/social-capability-inventory.md`. `docs/FRONTEND-BFF-CONTRACT.md` §19 changes: the
dispatch endpoint row (`POST variants/:variantId/publish`, previously prose-only), the webhook
intake row (`POST webhooks/post-status`), the two SMM-21 metrics rows (`GET metrics/daily`,
`GET metrics/posts`) — every row added was checked against the controller source read directly in
this pass, not carried over from a prior claim. No product code touched (out of this ticket's
surface); every gap found where a doc claim would have required a code change to be true is reported
above and in the inventory file, not invented around.

**SMM-33 gap-closing evidence (2026-08-21, senior-be).** Worktree was cut 6 commits behind `main` —
missing `docs/modules/social-capability-inventory.md`, `client-review.ts`, and
`publisher/youtube-client.ts` entirely (the exact three files this ticket's own brief named as the
tripwire). `git merge main` (clean fast-forward, no divergent commits) pulled everything in before
any of this pass's own code was written; flagged per this file's own repeated cross-session hazard.

**Gap 1 — the client-review capability group's zero MCP tool coverage — CLOSED.** Three tools
declared on `socialModule.mcpTools` (`modules/social/index.ts`): `social.requestClientReview`
(POST `.../client-review`, write, impact `'medium'`), `social.getClientReview` (GET the same path,
plain read, no write/impact pair), `social.withdrawClientReview` (POST `.../client-review/withdraw`,
write, impact `'low'`) — each fronting the SAME `authorize()` call its existing endpoint
(`social.controller.ts`, SMM-31) already runs. `request`'s 'medium' rests on the same "outward-
facing" ground `deliverReport`/`provisionPublisherOrg` already use — it is the first moment content
crosses the client trust boundary (notifies the client's portal contacts) — so an automation/agent
principal is suspended into WS4 rather than allowed to expose unreviewed content unsupervised.
`withdraw`'s 'low' rests on `syncConnectorRegistry`'s own "blast radius is a stale row" ground: it is
a write (never a read — the ticket brief's own warning), but purely corrective, and never notifies
the client (`social.client_review.withdrawn` rides the drained stream but has NO registered handler
in `event-handlers.ts`, unlike `.requested`/`.decided` — a real gap found while reasoning about the
impact class, named here, NOT fixed this pass: `event-handlers.ts` is outside this ticket's file
surface). Neither `request` nor `withdraw` is registered in `approval-executables.ts` — the same
shape `setEngagementScope`/`provisionPublisherOrg`/`deliverReport` already have (all 'medium'/none
executable), so a suspended call stays suspended for a human to act on directly; no
`resource_mcp_tool.yaml` change was needed (that grant-lift list mirrors ONLY the executable
registry, per its own header, and nothing was added there).

**The portal decide's absence confirmed, not just repeated.** `social-client-review-portal.
controller.ts`'s `decide` is a `portal.*` Cerbos action (`approve_post`), never `social.*` — the
client's decision is a human act on the trust boundary, made in an authenticated browser session,
never something any agent is the caller of. Regression-pinned in `social.test.ts`: no tool name
contains "decide", no `pathTemplate` contains `/portal/`.

**Gap 2 — the post-status webhook's missing `work_activity` row — CLOSED at the shared root.**
`applyPostStatuses` (`post-status-sync-job.ts`) is the ONE function both `reconcileOneProviderPost`
(the webhook intake, the inventory's own named gap) and `reconcileTenantPostStatus` (the safety
poll) call to apply the network's own authoritative `'published'`/`'failed'` status — fixing it once
closes the gap for both paths, not just the named one. `writeActivity(tenantId, null, verb,
"social_post_variant", variantId, metadata)` fires AFTER the update transaction commits (collected
into a `pendingActivity` array during the loop, matching `dispatch.ts`/`pm.controller.ts`'s own
non-nested sequencing for this same helper). `actorId` is `null` — the honest answer, not a guess:
neither caller ever has a principal (`postStatusWebhook` doesn't even take a `@Req()`), matching the
`activities` table's own column comment ("NULL = system/service") and the SAME convention
`pm.controller.ts`'s `auto_promoted` rows already use for a system-derived change nobody's own
action caused. No module-GUC exposure introduced (`activities` is a core table, no third wall, so
`declareSocialModuleScope` is correctly absent from the new code).

**Regression tests, driven RED first.** `post-status-sync-job.test.ts`'s (T1)/(T2)/(T3)/(T5) gained
a `activityRows()` helper + new assertions on the SAME existing cases that already carry this file's
own module-GUC regression note (0 new `it()`s — assertions added, not new tests, matching this
program's preference for fewer, denser tests). Verified RED by temporarily commenting out the
`writeActivity` call and re-running: all four new assertions failed exactly as predicted (`expected
[] to have a length of 1`), then restored. `social.test.ts`'s existing registration test gained
assertions for the three new tools' shapes and the portal-decide-absence checks above.

Test counts: **483 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline **measured directly** by stashing this
pass's changes: **483 / 0 / 5** — unchanged, because every new assertion extended an existing
`it()` rather than adding one; one suite, `dispatch.test.ts`, failed on the very first baseline run
with `tuple concurrently updated` — reproduced as the shared-test-Postgres phantom failure this file
warns about, confirmed green (16/16) re-run alone, not a real baseline failure). `tsc --noEmit`
clean. `lint:withtenants`/`lint:migration-rls`/`lint:migration-names`/`lint:postiz-deps` all green.
No migration, no Cerbos policy change. `test:iam-chain-alignment` not re-run (no IAM/Cerbos touched
this pass). Full detail: `docs/modules/MODULES.md`'s social-media 0.5.11 entry.

**Anything the spec did not answer, named rather than silently decided:**
`social.client_review.withdrawn`'s event has no registered handler in `event-handlers.ts` — found
while reasoning about `withdraw`'s impact class, but that file is outside this pass's surface and
the gap is cosmetic today (nothing depends on a withdrawal notification existing), so it is left for
a future pass rather than fixed unilaterally.

**SMM-21 evidence (2026-08-20, medior).** Schema already in place (`0105`'s `social_metrics_daily`/
`social_post_metrics`) — no migration, no Cerbos change. Built:

- **`platform-nest/src/modules/social/metrics-job.ts`** (new) — the nightly `pullMetrics` sweep,
  shaped exactly like `inbox-retention-job.ts` (SMM-36) / `post-status-sync-job.ts` (SMM-10):
  `withGlobal` for the tenant list, then per tenant a declared-module-scope READ, the driver call
  OUTSIDE any transaction (network I/O never belongs inside one), then a declared-module-scope
  WRITE. Two independent halves, one failing does not starve the other: (A) one `getAccountMetrics`
  call per connected account, upserted into `social_metrics_daily` on `UNIQUE(account_id, date)`;
  (B) one `getPostMetrics` call per (publisher org, batch of published `provider_post_id`s, 30-day
  lookback — an operational job parameter, not a business/quota constant), APPENDED into
  `social_post_metrics` (0105 designs it as an append-only snapshot history — a re-pull is a new
  row, never an overwrite). Per-tenant and per-account/org failures logged and swallowed.
- **The module GUC, the ticket's own named risk, addressed the same way every prior job in this
  module addressed it**: `applyAccountDailyMetrics`/`appendPostMetrics` each declare their own
  `declareSocialModuleScope` before touching a row. `metrics-job.test.ts`'s (T1)/(T5) call these
  functions exactly as written — no `{modules:['social']}` at the call site — and assert a REAL row
  exists afterward; delete either declaration and the assertion fails with "written: 0" instead of a
  real write, the precise "0 rows synced, looks perfectly healthy" shape the brief warned about.
- **No invented numbers, proven at three layers.** `DailyMetrics`/`PostMetrics` (the
  `SocialPublisher` port) have every field OPTIONAL; an absent field is SQL NULL end to end, never
  coerced to 0 — (T2)/(T6) in `metrics-job.test.ts` re-read the DB directly and assert `null`,
  `metrics-endpoints.test.ts` asserts the same over HTTP, and the browser pass below confirms the
  Analytics tab renders it as an em dash.
- **Dark by default.** `socialMetricsPullEnabled()`/`socialMetricsPullIntervalMs()` read
  `SOCIAL_METRICS_PULL_ENABLED`/`SOCIAL_METRICS_PULL_INTERVAL_MS` directly from `process.env` —
  deliberately NOT through `config.ts`, which (along with `main.ts`) SMM-38a's parallel worktree
  held for this ticket's whole duration. `startMetricsPullLoop` is written, exported, and tested,
  but **not wired into `main.ts`** — that one-line registration (`import { startMetricsPullLoop,
  socialMetricsPullEnabled, socialMetricsPullIntervalMs } from "./modules/social/metrics-job";` plus
  `if (socialMetricsPullEnabled()) { startMetricsPullLoop(socialMetricsPullIntervalMs()); }`,
  mirroring the `inboxRetention`/`reconcile` blocks already there) is handed to the merge
  orchestrator rather than applied here.
- **Two new read-only BFF routes** on `social.controller.ts`, `social_account`/`read` (the same
  permission `GET accounts` already uses): `GET metrics/daily` (per-account daily series, optional
  `accountId`/`from`/`to`, 400 `missing_field` without `engagementId` — accounts are client-scoped,
  not engagement-scoped, so there is no other way to know which client's rows to read) and
  `GET metrics/posts` (the LATEST `social_post_metrics` snapshot per published variant via
  `DISTINCT ON (variant_id) ... ORDER BY fetched_at DESC`). The `date` column is selected via
  `::text`, not handed back as a raw JS `Date` — the SAME node-pg timezone-shift trap
  `pm.controller.ts`/`document-builder.ts` already guard every date column against; caught live by
  `metrics-endpoints.test.ts` (a seeded `2026-08-15` row came back `2026-08-14` on this host's local
  timezone before the cast was added) rather than shipped silently wrong.
- **Frontend**: `lib/socialShared.ts`'s `DailyMetricRow`/`PostMetricRow` (all-optional per field,
  mirroring the port), `lib/social.ts#listDailyMetrics`/`listPostMetrics`,
  `components/social/AnalyticsPanel.tsx` (a pure server component — no `globalThis` mutation trap
  applies, this is read-only — with `fmtMetric` as the ONE place a number becomes text, so there is
  exactly one place to audit for "never fabricate a 0"), and `departments/[deptId]/analytics/
  page.tsx` now renders real per-account/per-post tables with an engagement filter (mirroring
  `calendar/page.tsx`'s own filter pattern) instead of the `BackendPending` placeholder.
- **DEMO_MODE** (`demoSocial.ts`): `dailyMetrics`/`postMetrics` seeded onto the SAME
  `globalThis`-pinned `SocialStore` (no new mutation-bundling risk — both new routes are pure
  reads), deliberately partial: one daily row seeded WITHOUT `reach`/`engagements`/`linkClicks`/
  `videoViews`, one post-metrics row seeded WITHOUT `saves`/`videoViews`/`clicks` — so "absent
  counter renders as unknown, never zero" is drivable live, not only asserted in a unit test.

**Driven in a real browser** (`DEMO_MODE=1 npm run dev`, Playwright, headless Chromium; `next build`
NOT re-run per this ticket's own "don't run it repeatedly" instruction): logged in, switched the
active-tenant cookie to the agency company, opened Social Media → Analytics. Confirmed: the
per-account daily table renders real numbers for followers (4,180) and impressions (6,200) on the
earliest seeded day while reach/engagements/link clicks/video views render as **em dashes** on that
SAME row (never `0`), then full real numbers on the following two days; the published-posts table
renders one row with `saves` as an em dash while impressions/likes/comments/shares are real numbers;
the engagement filter switches between both seeded engagements and both correctly show the SAME
account-level series (proving the join runs through the engagement's `client_id`, not a fabricated
per-engagement slice — accounts are client-scoped by design). A column-spacing defect found in the
same pass (`.lux-table`'s grid gap lives on `.lux-table__head`/`.lux-table__row`, not on the `.lux-
table` wrapper, which is only a flex column) was caught by this same browser pass and fixed before
merge, not left for a later polish ticket.

Test counts: **337 / 0 / 0** `platform-nest` (baseline 318/0/0, +19: `metrics-job.test.ts` 13,
`metrics-endpoints.test.ts` 6). **2399 / 0 / 0** `platform-ui` (baseline 2392/0/0, +7:
`social-metrics.test.ts`). `tsc --noEmit` clean on both sides.

**Anything the spec did not answer, named rather than guessed:** (1) no MCP tool/agentic-surface
entry for the two new read routes — the ticket brief named `pullMetrics` + the tables + the nightly
flow + the Analytics tab, not an agent-facing tool; (2) the post-metrics lookback window (30 days)
and the daily-pull window (3 days back) are operational job parameters, not business/quota
constants — the "no invented numbers" rule is about values a caller could mistake for something the
engine reported, which these are not, but naming the choice here rather than silently picking it;
(3) `main.ts` registration is NOT applied — handed to the merge orchestrator (exact line above)
since `main.ts`/`config.ts` were off-limits for this ticket's duration.

**SMM-23 evidence (2026-08-20, medior).** Schema/IAM already in place (`0105`'s `social_reports`,
`0106`'s catalog rows + `resource_social_report.yaml` — SMM-30's forward-looking seed, whose own
yaml note says "no real handler for social_report exists anywhere in the tree yet"). This ticket is
that handler. No migration, no Cerbos change.

**Cross-session hazard, hit directly.** This worktree was cut BEFORE SMM-21's merge (`9a5a8f5`)
reached `main` — `metrics-job.ts` and the two `GET metrics/*` routes were entirely absent
(`social.controller.ts` had 89 fewer lines than the merged version). `git merge main` (clean, no
conflicts — SMM-21's diff touched only `social.controller.ts`+new files, never `index.ts`/
`app.module.ts`, which is where this ticket's own edits landed) pulled it in before the snapshot
builder was written against a tree that would have been missing the tables' read source entirely.
Re-verified `365/0/0` on the merged baseline before adding anything.

Built: `platform-nest/src/modules/social/reports.ts` (new, pure) —
`buildSocialReportSnapshot`/`buildSocialReportDocument`, freezing the metrics snapshot into
`social_reports.metrics` at creation (never recomputed on a later read, mirroring
`search_reports`'s own "read VERBATIM from the frozen column" rule). `social-reports.controller.ts`
(new, its own controller class sharing `SocialController`'s route prefix, for the same reason
`search-reports.controller.ts` gives — three other seats hold `social.controller.ts` this wave):
`POST engagements/:id/reports` (snapshot + AI narrative, idempotent on a caller id), `GET reports`
/ `GET reports/:id` (list/detail, the latter a full `ReportDocument`), `PATCH reports/:id`
(edit/submit/send-back), `POST reports/:id/approve`, `POST reports/:id/deliver`.

**No invented numbers — proven, not asserted.** `sumKnown`/`latestKnown` (`reports.ts`) return
`null`, never `0`, when a metric was never pulled for the period; the corresponding `ReportKpi` is
OMITTED from the array, never rendered as zero. A real own-row count (posts published this period)
is the one deliberate exception — a genuine zero there is a known fact, not an absent counter.
`social-reports.test.ts` seeds one day with `impressions` pulled and one without, and asserts the
KPI sums only the known day while `reach_period` (never pulled all period) is absent from the array
entirely; a post's `likes` (never fetched) renders `null` in the `top_posts` table.

**The narrative rides SMM-19's gateway path — no second route to `ai-gateway-go`.** `ai-drafts.ts`
gained `buildReportNarrativePrompt`/`parseReportNarrativeDraft` (fail-soft, same shape as the
caption/idea pair already there): the prompt hands the model ONLY the already-filtered real
numbers and instructs it never to state one it wasn't given; a gateway failure or unparsable
response falls back to a deterministic template built from those same numbers, and which one
happened is frozen (`narrativeSource`) so a later read never claims an AI narrative that a fallback
actually produced. **Named limitation**: unlike the hashtag cap (mechanically enforceable), no
runtime guard strips a hallucinated number out of free-form prose — the prompt instructs against
it; the parser validates JSON shape only.

**The cross-client leak test** (`social-reports.test.ts`), same fake-WS8-server technique
`social-ai-drafts.test.ts` uses (a store holding BOTH clients' corpora, reimplementing the real
`scope = ANY(acl)` predicate): a report for engagement A's client grounds its narrative ONLY in
client A's ingested excerpt (asserted on the actual prompt text AND on the WS8 request's own
`scope` field) — never client B's — and the same in reverse. The scope is derived from the report's
own engagement→client join, never a request field.

**Approval mechanism — read both existing surfaces, reused neither, and said why.** SMM-09's D14
registry re-executes a suspended write the instant a human approves it; nothing here dispatches on
approval — `deliver` is its own later, separately-gated step — so registering it would suspend an
ordinary sign-off into the automation-approvals inbox for no reason. SMM-31's client-review stage is
the CLIENT's sign-off on a POST before publish: a different table, a different wall (plain tenant
wall per D-16/Δ8, not the third wall), and `resource_social_report.yaml`'s own invariant comment
("`client` appears NOWHERE") rules it out on its face. What fits, verbatim from `smm-design.md` §07:
"Low-impact artifacts (reports, campaign plans) approve in-console via module permissions." Built
exactly that, mirroring `search-reports.controller.ts`'s own `draft → in_review → approved →
delivered` state law byte-for-byte (compare-and-swap UPDATE guards against the status the handler
itself read, same idiom).

**Render reuses TR-21's sidecar — invents nothing.** `deliverReport` shapes the frozen snapshot +
narrative into a `ReportDocument` (the reports module's own contract,
`platform-nest/src/modules/reports/report-document.ts`) and calls the SAME
`mintPrintJobToken`/`renderPdfViaSidecar` (`reports/report-pdf-export.ts`) TR-21 built for the
4-grain tracker's own PDF export — no new renderer, no new print route, no new sidecar client.
`header.grain` is pinned to `"company"` (the closest of the four existing grains to a client
engagement — adding a fifth is out of this ticket's file surface, since `report-document.ts` and
its FE mirror `platform-ui/src/lib/reports.ts` are both off-limits). **Named limitation**: the print
page's per-grain `GrainCharts` composition (`CompanyCharts`) doesn't know this document's own
series/table keys, so today only the KPI wall, highlights and narrative render on the PDF; the
series/tables ARE present in the JSON `ReportDocument` (available to a future console read or chart
wiring) but not yet on the rendered page. Proven with a REAL sidecar round trip — a stand-in HTTP
server that itself fetches the real `/internal/reports/print-payload/:jobToken` route over an
actual socket (same technique `reports.controller.export.pdf.db.test.ts` uses), not a mocked call.
`files` row written (`target_entity_type='social_report'`); the Drive mirror is WS11's existing job
(out of this ticket's scope, per `search-reports.controller.ts`'s own precedent comment);
`deliverables` link best-effort when the engagement carries a `project_id`. Re-delivering an
already-delivered report is refused (compare-and-swap); approving from any status but `in_review`
is refused.

**Absent metric on a rendered report:** never a `0` — the KPI is missing from the wall entirely, the
`top_posts` row shows the column blank, and the narrative names it as "not yet fetched."

6 new MCP tools (`social.draftReport`/`listReports`/`getReport`/`editReport`/`approveReport`/
`deliverReport`; `deliverReport` is `impact:'medium'` — outward-facing and unretractable, the same
ratified ground `search.deliverReport` uses; the rest `impact:'low'`), 5 new `social.report.*`
permissions declared on the module contract (already-catalogued rows from SMM-30's seed; `delete`
stays undeclared — no endpoint honours it yet, matching `search.report.*`'s own precedent).

Test counts: **370 / 0 / 0** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `social-client-review-portal.controller.test.ts` (baseline 365/0/0, +5: `social-reports.test.ts`
— no-invented-numbers, module-GUC regression [pinned by asserting a real row is readable through
every `{modules:["social"]}`-declared query path — the exact shape that reads zero rows silently if
the declaration is dropped], the cross-client leak test in both directions, idempotent create [no
second gateway call on a retry], and the full lifecycle against a REAL report-renderer sidecar
round trip). `tsc --noEmit` clean. `lint:withtenants` green (349 files). `test:iam-chain-alignment`
green (25/25, unaffected). `role-permission-bundles.db.test.ts`/`role-bundle-completeness.db.test.ts`/
`role-catalog-drift.db.test.ts` green (15/15, unaffected — no catalog/Cerbos change this pass).

**Anything the spec did not answer, named rather than guessed:** (1) `header.grain: "company"` is a
repurposing, not a real fifth grain (see the render section above); (2) the narrative's "no invented
numbers" guarantee is prompt-level only, not a runtime numeric-provenance guard (see above); (3) a
report's `period` for `kind='campaign'/'adhoc'` with no explicit value falls back to a trailing
30-day window, mirroring `search/reports.ts#periodDateRange`'s identical fallback — not specified by
the ticket, named as a deliberate choice; (4) `social_kpi_targets` vs. actual is included in the
frozen snapshot as its own table when targets exist, but is not wired into the narrative prompt — a
report with targets set gets no AI commentary on over/under-target, left for a later pass; (5) no
delivery notification/mail routing was added for `social.report.delivered` (the event is emitted;
no handler consumes it yet — lower urgency than SMM-31's client-review notifications, and adding a
handler with no reviewer/recipient list specified would have been guessing at UX the ticket didn't
name); (6) `docs/FRONTEND-BFF-CONTRACT.md`/`docs/MAP.md` were off-limits this pass — the six new
endpoints and one new controller are not yet reflected there, same standing gap SMM-24's own docs
pass named for SMM-21's routes before it closed them.

**SMM-20 evidence (2026-08-21, medior).** Schema already in place (`uploaded_media`/`media` both
existed) — no migration, no Cerbos change. **Generation is OUT of scope** (D-17, amending the base
ticket) — no generative-image backend exists in the estate.

Built: `social.controller.ts`'s new asset-library section — `GET
engagements/:engagementId/asset-library` (reads `files` rows attached to the engagement's CLIENT
plus every tenant-wide Studio-graded `creative_assets` row) and `POST
variants/:variantId/media/attach` (writes ONE `{fileId, kind, alt, format}` descriptor into
`social_post_variants.media`, recomputing `args_sha256` and invalidating an approved/in-review
variant exactly like `updateVariant` already does for a body/settings edit — never touching
`uploaded_media`, D-15's separation, so `dispatch.ts`'s engine-upload path (SMM-39) is completely
unedited and unaffected). Attaching a Studio-graded asset **materializes exactly one `files` row**,
reusing the SAME `graded_key` as the new row's `storage_key` — zero duplicated bytes, and idempotent
by construction (a second attach of the same asset reuses the same `files` row rather than growing
a duplicate one; proven with an assertion, not a claim).

**The module-GUC boundary, drawn deliberately (defect class #1).** `files`/`creative_assets` carry
NO `{modules:["social"]}` anywhere in this ticket's new code (they are not `social_*` tables);
every query against `social_engagements`/`social_post_variants` DOES carry it. The new tests assert
REAL state through the real endpoint (a materialized `files` row found by a follow-up SELECT, a
changed `args_sha256`, a variant actually dropped back to `draft`) — deleting `{modules:["social"]}`
from the social-side queries would make those assertions fail with "0 rows"/404, never pass
vacuously (the exact regression shape the ticket brief named).

New refusal tokens (`unsupported_asset_source`, `asset_not_found`) render as themselves via
`REFUSAL_LABELS`, never a generic error.

**The `ai.imageGen` inert affordance, in the surface itself, not only in the pre-existing backend
warning.** `VariantCard.tsx`'s new `MediaPanel` renders a permanently-disabled "Generate with AI"
button next to the working attach-from-library flow, with the literal D-17 sentence: no
generative-image backend exists anywhere in the estate (`ai-gateway-go`: `/complete`,
`/complete/stream`, `/media`, `/embed` — nothing generative; the Creative render gateway is `0.0.0
PLANNED`). Deliberately NOT conditioned on the engagement's own `ai.imageGen` scope value — flipping
that toggle changes nothing about whether generation exists, so the control stays disabled and the
sentence stays visible either way; a toggle that silently does nothing would be worse than this.

**Driven in a real browser** (`DEMO_MODE=1 npm run dev`, headless Chromium, `SESSION_SECRET` set,
logged in as a manager identity, switched to the agency tenant): opened a composer post with two
already-approved variants (`soc-post-3`), opened "Attach from library", saw the Files & Drive
section (one uploaded file, one video, one Drive-mirrored reference rendered distinctly as "drive
reference — no bytes of ours") and the Studio-graded section (two graded assets with their preset
ids), attached a Studio asset — it appeared as `image (webp): demo-file-from-demo-studio-1`
(confirming the content-type-derived `kind`/`format` default), detached it via the × control back
to one entry, and confirmed the disabled "Generate with AI" button with its full sentence renders
directly beneath the library, unconditionally.

Test counts: **352 / 0 / 0** across `src/modules/social` +
`d14-smm-09-social-publish-registry.test.ts` + `social-client-review-portal.controller.test.ts`
(+27 new — this ticket's own SMM-20 describe block in `social.test.ts`; the pre-ticket baseline in
this worktree read 291+53+8=352 before the new tests were added, and the same after — see the
worktree-cut note above the scoreboard for why this doesn't match the 346/0/0 another session's
evidence reported against a newer `main`). **2437 / 0 / 0** `platform-ui` full suite (+27:
`socialShared.test.ts`). `tsc --noEmit` clean both sides. `lint:withtenants`/`lint:migration-rls`/
`lint:migration-names`/`lint:postiz-deps` green. `test:iam-chain-alignment` green (25/25,
unaffected). Full detail: `docs/modules/MODULES.md`'s social-media 0.5.6 entry.

**Anything the spec did not answer, named rather than guessed:** (1) a `files` row with neither
`storage_key` nor `url` (a genuinely byte-less, link-less reference) is still attachable by this
endpoint — dispatch's own pre-existing `mediaUploadFailed` refusal already covers that case at
publish time, so this ticket did not add a second guard for it; (2) no new Cerbos check gates
*which* `files`/`creative_assets` rows may be attached beyond the caller already holding
`social_post`/`update` on the target variant — `social_staff`/`social_manager` are module-scoped
roles with no blanket company-wide `file` grant, so a second `file`/`client` Cerbos check (which an
earlier pass of this ticket added, then removed after the test suite caught the resulting 403s)
would have refused the exact staff this ticket is for; (3) detach reuses the pre-existing
`updateVariant` PATCH rather than a new endpoint — sending the filtered `media` array is itself a
legal edit under the SAME editability law, so no new backend surface was needed for removal.

**SMM-22 evidence (2026-08-22, senior-be).** Worktree started 6 commits behind `main`'s tip
(`git log --oneline -1` did not match; `git merge-base --is-ancestor HEAD main` confirmed) — missing
SMM-17's own inbox-reply landing (`reply-precondition.ts`, `InboxWorkspace.tsx`) entirely. `git merge
main` (fast-forward, clean) pulled everything in before any of this ticket's own code was written,
stated per this file's own repeated cross-session-hazard note.

**No migration.** `social_usage_ledger` and `social_engagements.usage_budget_usd` (both 0105) already
carried everything this ticket needed.

**The barred twin, made real without unbarring anything by default.** `social.publishPostMetered`
now has a genuine dispatch endpoint (`POST variants/:variantId/publish-metered`, `social.controller.ts`,
wired to the SAME `dispatch.ts#dispatchApprovedPublish` the free tool uses — one implementation,
`toolName` threaded through) and a declared `McpToolDef` (`modules/social/index.ts`) — the module
contract's own "don't declare a tool with no endpoint" rule no longer blocks it, since the endpoint is
now real. What did NOT change: `core/approval-executables.ts`'s bar on it, which stays the default
(`config.social.usage.meteredPublishEnabled` defaults `false`, unset by every existing deployment) —
`registerSocialExecutableApprovals()` still bars it exactly as SMM-09 left it. Lifting the bar is a
NEW, deliberate primitive (`liftBarredExecutable`, approval-executables.ts) called from exactly ONE
config-gated site (`registerSocialMeteredExecutableApprovalIfEnabled`) that THROWS AT BOOT if
`SOCIAL_METERED_PUBLISH_ENABLED=true` while X's per-post price
(`SOCIAL_X_PER_POST_COST_USD`/`SOCIAL_X_PER_POST_WITH_LINK_COST_USD`) is unconfigured — an
auto-executing money tool with no price is exactly the "under-count" failure this ticket exists to
prevent. `d14-smm-22-social-metered-publish-registry.test.ts` (B1)/(B2)/(B3)/(B4) prove: boot-refuses
when enabled+unpriced (both halves — either price alone is not enough), lifts cleanly when priced
(real lockKey, `neverAutoRetry:true`, free tool untouched), and re-running the bootstrap with the flag
off is a no-op (stays barred). `metered_network_requires_metered_tool` (SMM-09's own check) still
refuses a metered-network variant on the free tool — unchanged, re-proven by (C4a). A NEW symmetric
check, `metered_tool_requires_metered_network` (C4b), refuses the other direction (a non-metered
variant on the metered tool) — belt and braces, since there was previously no reason to guard it.
Cerbos's `resource_mcp_tool.yaml` executable-tool list was DELIBERATELY NOT touched — the code-side
flag is the real gate either way, and hand-editing a security policy file as a side effect of an env
var felt like exactly the kind of silent half-unbar this ticket was told not to do; a deployment that
lifts the bar AND wants agent/automation-origin re-drives (as opposed to a human's own manual
`publish-metered` call, which needs no Cerbos change) must add that entry itself — named as a
follow-up, not done.

**The stop-loss chain's three tiers, and proof that BOTH checkpoints enforce them — not one.**
Engagement (SMM-09's own, unchanged) → tenant (new) → global (new), `usage-ledger.ts#evaluateUsageBudget`,
one implementation reused by both checkpoints:
- **The precondition** (`publish-precondition.ts`'s budget stage, run by the D14 executor AND by
  `dispatch.ts`'s own re-run) now evaluates all three tiers for a metered network.
  `d14-smm-22-social-metered-publish-registry.test.ts` (C1) proves the TENANT tier alone refuses a
  fresh engagement with plenty of its OWN headroom, because a DIFFERENT engagement in the same tenant
  already spent past the tenant cap; (C2) proves the GLOBAL tier the same way across two DIFFERENT
  tenants. Both run `evaluatePublishPrecondition` directly, with `dispatch.ts` nowhere in the call
  stack — this is the precondition's OWN enforcement, independently proven.
- **The reservation** (`dispatch.ts`, new) is the ledger's own "ONE choke-point before dispatch"
  (0105's header): a per-ENGAGEMENT advisory lock (`SOCIAL_USAGE_LEDGER_LOCK_NS`, a NEW namespace,
  distinct from the variant lock), re-sums all three tiers ONE LAST TIME under it, and inserts the
  `posted` ledger row atomically — all BEFORE any network call. `usage-ledger.test.ts` (T5) proves it
  airtight against two SEQUENTIAL reservations that each individually fit but jointly exceed the cap
  (deterministic, no timing dependency). `dispatch.test.ts` (M5) proves the END-TO-END property under
  REAL concurrency: two variants on the same engagement, `Promise.all`'d, room for exactly one —
  exactly one dispatch succeeds, the other refuses `budget_exceeded`, and exactly one nonzero-cost
  ledger row exists afterward. Re-run 5× with no flake.
- **⚠ A real design defect found and fixed before it shipped:** the first version of the precondition
  change applied the tenant/global tiers to EVERY publish, including $0 ones — meaning a single
  tenant's X overspend would have frozen every OTHER tenant's free Instagram/Facebook posting
  platform-wide the moment the global cap was breached. Fixed: the tenant/global tiers now gate ONLY
  an actually-metered dispatch (`METERED_NETWORKS.has(network)`); a $0 post's only budget exposure is
  still the pre-existing, unchanged, engagement-scoped circuit breaker SMM-09 already shipped.

**X's per-post price** is `config.social.usage.xPerPostCostUsd`/`xPerPostWithLinkCostUsd`
(`SOCIAL_X_PER_POST_COST_USD`/`SOCIAL_X_PER_POST_WITH_LINK_COST_USD`, `moneyEnv` — throws on an
unparseable value, `null` when unset) — no default ships, and design §05's own ~$0.015/~$0.20 figures
are its own "re-verify at build time" caveat, never copied in as a measured fact.
`media-rules.ts#estimateCostUsd`'s contract changed from returning a bare `number` to
`{ok:true,costUsd}|{ok:false,reason:"x_price_not_configured"}` — an absent price now REFUSES
(`metered_price_unconfigured`, new token) everywhere it is consulted (the precondition's budget
stage, `dispatch.ts`'s own reservation, every composer/approval-card read on `social.controller.ts`)
rather than silently pricing at $0. The GLOBAL cap has a documented default
(`SOCIAL_GLOBAL_MONTHLY_CAP_USD`, `numericEnv`, default $100/mo — design §05's own words, "until X
usage is proven"); the TENANT cap is optional, unset-skips-tier, mirroring `search`'s own
`tenantMonthlyCapUsd` convention exactly.

**A ledger row, posted → completed/failed, and who trues it up.** `dispatch.ts`'s reservation inserts
`posted` at the estimate. On a SYNCHRONOUS dispatch failure (schedulePost threw, or media/OAuth
resolution failed before any network call), `dispatch.ts` itself releases it
(`markUsageLedgerFailed`, cost → 0, same statement) — nothing was spent. On SUCCESS, the row
deliberately STAYS `posted` (the variant's own status is `queued`, not `published`, at that same
instant) — `post-status-sync-job.ts`'s EXISTING reconcile sweep (`applyPostStatuses`, both the safety
poll and the webhook intake) is extended to true it up IN THE SAME TRANSACTION as the variant's own
authoritative status flip: `published` → `completed` (cost unchanged — X's price is flat, there is no
"actual" to correct, unlike search's own vendor-reported true-up), `failed`/`cancelled` → `failed`
(cost → 0, released). `post-status-sync-job.test.ts` (T7a-e) proves all four outcomes plus the
idempotent-redelivery case (a second webhook/poll for an already-`completed` row touches nothing) and
that a non-metered variant's reconcile never even looks for a ledger row.

**The estimate on the approval card.** `GET variants/:variantId/publish-preconditions`
(`social.controller.ts`) now returns `estimatedCostUsd`/`costUnavailableReason` alongside the verdict
— computed fresh (never the stored column), `null` only for an unpriced X variant, rendered by
`VariantCard.tsx`'s existing "Check now" preview as either a "this will cost $X" line or an honest
"no price configured, this will refuse" warning. Every composer write path
(`createVariant`/`updateVariant`/`attachMedia`) now refuses the WHOLE write
(`resolveEstimatedCostOrRefuse`) rather than persisting a fabricated `$0` when X pricing is
unconfigured; the two GET-only reads (`getVariantValidation`, the approval card above) answer
`estimatedCostUsd: null` as DATA, never a thrown refusal — asking is not spending.

**Usage panel + rollups.** New `GET engagements/:engagementId/usage` (`social.ledger.read`, already a
0106-forward-seeded permission — this is the first ticket to declare it) returns the same three-tier
snapshot the precondition evaluates. Rendered by a new `UsagePanel.tsx` on the Analytics tab (design
§08's own "usage/ledger panel" line), alongside the pre-existing `AnalyticsPanel`. The
`social.usage_cost.month` exec rollup (`modules/social/index.ts`) already existed from SMM-30's
forward scaffolding and needed no change — it was already reading `social_usage_ledger` correctly.
**⚠ NOT browser-driven** — unlike SMM-12/32's own Playwright-verified panels, this pass verified the
panel only by `tsc --noEmit` + the full platform-ui unit suite; DEMO_MODE fixture data was added
(`demoSocial.ts`, a synthetic, clearly-labeled MTD spend) but nobody drove it in a real browser this
pass. Named as a real gap, not silently claimed as DEV-VERIFIED.

**`main.ts` — genuinely nothing to hand over this time.** No new scheduled loop, no new module
registration call, nothing outside what Nest's own controller/module-contract auto-wiring already
covers — the first SMM ticket in this file's own history with an honest "no main.ts line" answer.

**Refusal tokens — every one, and which are new.** `metered_price_unconfigured` (new, budget stage)
and `metered_tool_requires_metered_network` (new, scope stage) are added to `PUBLISH_REFUSAL`; every
other token (`metered_network_requires_metered_tool`, `budget_exceeded`, the whole six-stage
vocabulary) is REUSED, unchanged.

Test counts: **591 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `d14-smm-17-social-reply-registry.test.ts` + the new `d14-smm-22-social-metered-publish-registry.test.ts`
(this ticket's own fourth file in the set). Baseline **measured directly**: immediately after this
ticket's SOURCE changes landed but before any of its own new test files were written, the same
`src/modules/social` set alone came back **476 passed, 1 failed, 5 skipped** — the one failure was
`publish-gate.test.ts`'s own pre-existing assertion that the metered tool "STILL never appears" on the
module contract, which stopped being true the moment this ticket declared its real endpoint (fixed,
not silently loosened — the test now asserts the twin IS declared but STAYS barred by default).
476 + 1 (fixed) + 39 new (16 `usage-ledger.test.ts` + 6 `dispatch.test.ts` M-series + 5
`post-status-sync-job.test.ts` T7-series + 12 `d14-smm-22-...-registry.test.ts`) + 53
(`d14-smm-09-...`, pre-existing, unaffected) + 22 (`d14-smm-17-...`, pre-existing, unaffected) = 591 —
matches the measured final figure exactly. The full combined run was executed TWICE (once mid-fix,
once final, after finding and fixing the $0-post budget-gating defect named above) landing on
591/0/5 both times; `dispatch.test.ts`'s (M5) concurrency test was additionally re-run alone 5× with
no flake. `tsc --noEmit` clean. `lint:withtenants`/`lint:migration-rls`/`lint:migration-names`/
`lint:postiz-deps` all green (no migration — still 130 files; the new cross-tenant global-sum read
needed NO lint-withtenants allowlist entry — implemented as a per-tenant fan-out, the lint's own
documented PREFERRED alternative to an architect-ratified exception). `test:iam-chain-alignment`
green (25/25, unaffected — `social.ledger.read` was already a catalogued, bundle-assigned permission
from SMM-30's forward-seeding; no Cerbos policy file touched).

`platform-ui`: **2592 / 0 / 0**, full suite, run twice (once before, once after the `rbac.ts`/
`rbac-capability-map.ts`/`demoSocial.ts` UI-wiring passes) and stable both times. `tsc --noEmit`
clean. `rbac-capability-parity.test.ts` includes the new `social.ledger.read` pairs (verified against
0106's own role_permission rows, not inferred) and stays green.

**Anything the spec did not answer, named rather than silently decided:** (1) whether X actually
charges on request-acceptance vs. confirmed-publish, and whether a later removal refunds, is a real
X-billing fact this ticket has no way to verify (no live X Developer Portal account, D-23) — the
ledger's own lifecycle (reserve at dispatch-acceptance, true-up on confirmed publish/failure) is the
best-supported reading of design §05's "estimated at dispatch, trued-up on completion" language, not
an invented assumption, but it is flagged as a assumption rather than a verified fact; (2) no
`social.ledger.admin` override endpoint was built (raise a cap, clear a blocked state) — the
permission stays catalogued-but-undeclared on the module contract, matching this file's own "don't
declare a permission before its endpoint exists" rule; (3) the usage panel is unit-tested, not
browser-driven (see above) — a genuine, named gap for a future pass or the merge orchestrator to
close; (4) `cerbos/policies/resource_mcp_tool.yaml` was deliberately left untouched even though
lifting the bar is now possible — an agent/automation-origin re-drive of an unbarred metered publish
needs that Cerbos entry too (D14-13's own doctrine), and adding it as a side effect of a code change
felt like exactly the silent half-unbar this ticket was told not to do; named as a follow-up for
whoever first sets `SOCIAL_METERED_PUBLISH_ENABLED=true` for real.

## P4 — agents + assistant 🟡

| # | Ticket | State |
|---|---|---|
| SMM-26 | MCP agent surface for automation principals (OBO, D14); agents draft, never publish | ✅ **merged** |
| SMM-27 | Best-time-to-post: classical stats + suggestion chip | ✅ **merged** — evidence below |
| SMM-35 | Assistant integration via ASST-23 propose → confirm → approve | 🟡 **partial, merged** — summary read only; no social write reachable from chat this pass (see evidence) |

**SMM-27 evidence (2026-08-23, medior).** Worktree was ONE MERGE BEHIND at cut time — `git log
--oneline -1` did not match `main`'s tip (SMM-35's own merge had landed) — `git merge main`
(fast-forward, clean) pulled `assistant-summary.ts`/`content-brief.ts` in before any of this
ticket's own code was written, stated per this file's own cross-session-hazard note.

**Deliberately not an AI ticket.** New `best-time.ts` is a pure, deterministic computation over
SMM-21's own `social_post_variants.published_at` + `social_post_metrics` — no gateway call, no
model, no prompt, per the ticket's binding instruction. The LATEST `social_post_metrics` snapshot
per variant is read (append-only history; "latest" is the Analytics tab's own reasoning); a variant
whose latest snapshot has every interaction field NULL is EXCLUDED from the sample — "not yet
measured," never a fabricated zero (`metrics-job.ts`'s own "no invented numbers" rule, applied here
to sample membership). Each measured post's score is the sum of whichever of
likes/comments/shares/saves/clicks it does carry; posts are bucketed by UTC hour of `published_at`,
and the highest-average bucket that clears its own sample floor is the suggestion.

**The clock: UTC, and why.** `published_at` is `timestamptz` (unambiguous), but extracting an
hour-of-day still requires picking a zone, and no per-account timezone column exists anywhere in
this schema. Rather than fabricate one — exactly the "fabricated precision" failure mode this
ticket's own brief warns against, pointed at a clock instead of a sample size — every bucket is
`EXTRACT(HOUR FROM (published_at AT TIME ZONE 'UTC'))`, deterministic regardless of session/process
timezone, restated because this module already shipped a real local-midnight/`toISOString()`
timezone bug at exactly this seam (SMM-35's `assistant-summary.ts` header). The chip renders
"14:00 UTC" verbatim, never implying a client-local hour that was never computed.

**Insufficient evidence is a first-class state, not an empty string — FOUR distinct facts.**
`BestTimeStatus` = `not_yet_computed` (the nightly sweep never ran for this account — what EVERY
real deployment reads today, D-23: no account is connected, no post has ever published anywhere in
the estate) | `insufficient_evidence` (fewer measured posts than `config.social.bestTime.
minMeasuredPosts`, or the winning bucket alone did not reach `minBucketPosts`) | `unsupported` (the
resolved driver never advertises `post_metrics` at all — checked via `driver.capabilities` BEFORE
ever querying `social_post_metrics`, the same "unsupported vs empty" discipline `inbox-sync-job.ts`
applies to `inbox_read` — a MORE PERMANENT fact than insufficient_evidence, never collapsed into it)
| `suggested` (a real answer, carrying its own `bestHourSampleSize`/`totalMeasuredPosts`).

**The threshold: CONFIG, with a documented rationale, never a constant that reads as measured.**
`config.social.bestTime.minMeasuredPosts` (default **5**) — a classical-stats rule-of-thumb floor on
independent observations before a mean says more than the underlying variance does, explicitly NOT
a claimed significance level and NOT vendor guidance (there is none for "how many of your own posts
before a best-hour claim is trustworthy") — and `minBucketPosts` (default **2**) — a second,
independent floor so a single lucky post sitting alone in one hour cannot "win" that hour outright.
Both thresholds ride the API response itself (`minMeasuredPostsThreshold`/`minBucketPostsThreshold`)
so the chip quotes them honestly ("3 of 5 measured posts needed") rather than a bare "not enough
data." Both are documented in `config.ts` inline, in the same idiom `triage.slaGuard`'s spike-
detection knobs already use.

**The module GUC — this ticket's own named worst failure mode, closed and regression-pinned two
ways.** Without `declareSocialModuleScope`, a stats job would read ZERO ROWS from
`social_post_variants`/`social_post_metrics` and SILENTLY compute `insufficient_evidence` from an
empty set — indistinguishable, at the API, from the honest answer every real deployment gives today.
`computeAccountBestTime`/`applyBestTimeSuggestion` (`best-time.ts`) each self-declare
`declareSocialModuleScope` on their own transaction, exactly like `metrics-job.ts`/
`inbox-triage-job.ts`. `best-time.test.ts`'s (G1) proves the TRAP ITSELF directly: seeds a real row,
then reads it back via a plain `withTenants([tenantId])` transaction with NO module option and
asserts ZERO rows come back, then re-reads WITH the option and gets the one row — proving the RLS
wall the declaration exists to satisfy is real, not assumed. (G2) proves the real functions — called
exactly as written, no `{modules:['social']}` at any call site — write and read back a REAL, correct
`suggested` verdict (hour 14, sample size 3, avg 50) from seeded data clearing every threshold; this
fails outright (0 measured posts, not merely a differently-labelled empty result) if either internal
`declareSocialModuleScope` call is ever removed.

**New migration `202608221603_social_best_time_suggestions.sql`.** `social_best_time_suggestions` —
one UPSERTED row per account (a current verdict, not a history, mirroring `social_metrics_daily`'s
own per-day cache), THIRD RLS wall (same as every `social_*` table but `social_post_client_reviews`,
FORCE RLS), `sbt_status_shape` CHECK making exactly one of the three persisted statuses
(`suggested`/`insufficient_evidence`/`unsupported`) hold structurally, self-asserted in the
0106/202608201519 idiom. `npm run lint:migration-rls` — **green** (132 migrations scanned, 53
baselined, 79 enforced, no unguarded FORCE-RLS backfill found). `lint:migration-names` and
`lint:withtenants` also green. Registered in `socialModule.migrations` at write time.

**The scheduled sweep (`smm-best-time`).** New `best-time-job.ts` mirrors `metrics-job.ts`/
`inbox-triage-job.ts` verbatim: `withGlobal` for the tenant list, per-tenant recompute+upsert over
every connected account, per-tenant AND per-account failures caught and logged so one bad
account/tenant can never abort the sweep. Env-gated via `config.social.bestTime.enabled`, dark by
default. `main.ts` was **not** edited (off-limits to this ticket) — the exact lines for the
orchestrator to apply:
```ts
import { startBestTimePullLoop } from "./modules/social/best-time-job";
// ...
if (config.social.bestTime.enabled) {
  startBestTimePullLoop(config.social.bestTime.intervalMs);
  console.log(`social best-time-to-post (smm-best-time) on: every ${config.social.bestTime.intervalMs}ms`);
}
```

**New endpoints + MCP tool.** `GET accounts/:accountId/best-time` (read, reuses the existing
`social_account`/`read` Cerbos gate `metrics/daily`/`metrics/posts` already use — no new
permission) answers `{status:'not_yet_computed'}` as DATA, never a 404, when the sweep has never
run; `POST accounts/:accountId/best-time/recompute` (same `read` gate — a re-derivation of
already-readable data with no blast radius of its own, so no D14/write classification) lets a
freshly-connected account get an answer without waiting up to a day for the next sweep tick. New MCP
tool `social.getBestTimeToPost` (read, `minAssurance:"low"`).

**The chip.** `socialShared.ts`'s `describeBestTime`/`formatBestHourUtc` render each of the four
states as itself (criterion-5 discipline, applied to a statistic instead of a refusal token) — never
blank, never a bare number dressed up as more confident than the sample backing it.
`VariantCard.tsx`'s new `BestTimeChip`, wired into the Composer
(`composer/[postId]/page.tsx` fetches one `getBestTimeToPost` per DISTINCT account across a post's
variants — the suggestion is a property of the ACCOUNT's own posting history, not the post, the same
"one value shared across variants" pattern `requiresClientOk`/`assetLibrary` already use, but keyed
per-account instead of per-post). DEMO_MODE store (`demoSocial.ts`) pins the new `bestTime` array to
the SAME `globalThis`-pinned `SocialStore` every other mutable demo state already uses (this file's
own recurring defect class #5), seeded across three accounts to drive three of the four states
without any interaction.

**Driven in a real browser** (`DEMO_MODE=1 npm run dev`, Playwright, headless Chromium — tenant
switched to `co-agency` via the company selector, dept `dept-4`, the department's real slug per
`lib/org.ts`/`demoReports.ts`, corrected from an initial wrong guess of `social-media`):
- `soc-post-2` (account `soc-acc-ig-1`, seeded 5 measured posts, 3 at hour 14) rendered *"Best time
  to post: around 14:00 UTC, based on 3 of 5 measured posts."* in the positive/confident color.
- `soc-post-4` (account `soc-acc-fb-1`, seeded 2 measured posts) rendered *"Not enough data yet: 2
  of 5 measured posts needed before a best time can be suggested."* in the caution color — **the
  insufficient-evidence state, the one every real deployment carries today, confirmed rendering
  correctly and visibly distinct from the confident state**, per this ticket's own instruction to
  drive exactly this state.
- `soc-post-1` (account `soc-acc-ig-2`, no seed) rendered *"Best-time-to-post hasn't been computed
  yet for this account."* in the muted color.
- The `unsupported` state (`soc-acc-tiktok-1`) was **not** reached in the browser pass — no existing
  demo variant targets that account — proven instead by `best-time.test.ts`'s (C1) against the mock
  driver with `post_metrics` removed from its capability set; named as a fixture gap rather than
  silently left unverified.

`next build` not run (this ticket's own "don't run it repeatedly" instruction); `tsc --noEmit` and
vitest are the gate.

**Test counts, both suites, measured directly on this worktree.** `platform-nest`
(`src/modules/social` + the three D14 registry files, 38 files): **613 / 0 / 5** — +12 new, all in
`best-time.test.ts`, re-run ALONE twice (12/12 both times), ruling out the shared-test-Postgres
phantom-failure class this file names. `tsc --noEmit` clean across the whole repo (the known
`src/rbac/role-permission-bundles.db.test.ts` failure another session is mid-editing is NOT present
as broken in this worktree — that file is uncommitted elsewhere, never merged in here).
`lint:migration-rls`/`lint:migration-names`/`lint:withtenants` all green. `platform-ui` (full suite,
155 files): **2615 / 0 / 0** — `socialShared.test.ts` (45/45) re-run alone, unaffected by the new
exports. `tsc --noEmit` clean for `platform-ui`.

**Anything the spec did not answer, named rather than silently decided:** (1) the `unsupported`
state has no demo-driven browser proof — a fixture gap (no demo variant targets the one seeded
tiktok account), not a code gap, and closed at the unit-test layer instead; (2) `avgEngagementScore`
sums raw interaction counts rather than a normalized rate (e.g. against impressions) — impressions
are optional/absent on many networks (`metrics-job.ts`'s own "partial reporting" note), so a rate
would silently exclude posts a raw sum can still rank; a reasonable classical-stats choice, not
provably the only one; (3) no day-of-week dimension — only hour-of-day, per the ticket's own "best
TIME to post" framing; a natural follow-up once real volume exists to support a second dimension
without starving both of sample size.

**SMM-35 evidence (2026-08-22, medior).** Worktree was CURRENT at cut time — `git log --oneline -1`
already matched `main`'s tip; `git merge main` fast-forwarded cleanly with only unrelated docs/infra
commits (an observability plan doc + an onboarding runbook), none touching `src/modules/social/**`
or `src/modules/assistant/**`. `content-brief.ts`/`usage-ledger.ts` were both present, confirmed
before writing any code.

**Read the two required docs first, as instructed.** `docs/superpowers/plans/2026-08-06-asst-23-
unblock-design.md` (the binding ASST-23 design — propose/confirm/approve, T1–T6/T2b/T3a/T3b, all
landed per `broker.ts`/`assistant.controller.ts`/`write-intents.ts`'s own code) and `assistant.
controller.ts` + `capabilities.ts` (where the mechanism actually lives). Confirmed by reading the
code, not the doc's own claims: `assistant_write_intents` holds the real `tool_args`; `confirmWriteIntent`
claims a `draft` row atomically (`status='draft' AND expires_at > now()`); the thread `GET`'s
lazy-reap flips a past-expiry draft to `expired` and scrubs `tool_args` to NULL in the same statement
(`assistant.controller.ts` lines ~403–406, `write-intents.ts`'s `reapExpiredIntents`).

**Exactly which social writes are reachable from `/assistant`, and what a confirm causes: NONE, this
pass.** Two different reasons for two different tools, not one blanket "writes are risky" excuse:
- **`social.publishPost`/`social.publishPostMetered`/`social.sendReply`** — excluded on SECURITY
  grounds, independent of file surface. All three are the pinned `write:true,impact:"high"`
  classification and already real D14-registry executables (`core/approval-executables.ts`'s
  `registerSocialExecutableApprovals()`/`registerSocialReplyExecutableApprovals()`) for the
  automation/agent-origin suspend path. Wiring either into a chat-confirm flow would be a SECOND,
  WEAKER route to a public, irreversible act — a human clicking "confirm" in a chat thread is not a
  more scrutinized gate than the existing approvals-inbox review, and the module's own standing
  invariant since SMM-26 ("agents draft, never publish") forbids it outright. Not built, and this is
  the legitimate "no" the ticket invited.
- **`social.draftContentBrief`** (`write:true,impact:"low"`, SMM-26 — genuinely low-stakes: every
  write is a draft row, never a live-network act, never client-visible) — excluded for a STRUCTURAL
  reason, not a risk judgment. The assistant broker (`platform-nest/src/modules/assistant/
  broker.ts`) can only drive a chat turn through an agent BOTH it (`ASSISTANT_AGENT_TOOLS`/
  `ASSISTANT_AGENT_WRITE_TOOLS`) AND `ai-agents/src/specialists.ts` declare together — `ai-agents` is
  a SEPARATE project (this repo's own "not a monorepo" rule) and was never listed in this ticket's
  file surface ("Yours" names only `platform-nest` paths; `src/modules/assistant/**` only "if
  genuinely required, say so loudly" — `ai-agents/**` is not mentioned at all). Per this file's own
  standing binding policy for the assistant surface — `task-filer`'s own header: "every assistant
  write becomes a proposal, never a silent commit," which is WHY `task-filer` declares `pm.createTask`
  `high_write` despite its genuinely-low hub tier — a hypothetical social write-agent would have to
  make the SAME honest divergence (declare `social.draftContentBrief` `high_write` regardless of its
  low hub impact) AND clear D13's eval-provider enrollment gate (a live run against the shared,
  weekly-rate-limited Ollama Cloud quota, per this program's own standing note on that resource)
  before `runWriteAgent` would let it execute past `forced_read_only`. That is a new AgentDef, a
  `RERUN_CAPABLE_HIGH_WRITES`/`ASSISTANT_FACING_AGENTS` guard update, eval cases, and a live
  enrollment run — `ai-agents/**` work sized and scoped like the original ASST-23 design's own T2
  ticket (`senior-be`, its own dedicated wave), not a medior platform-nest ticket's file surface.
  Reaching into `ai-agents/**` unilaterally, spending shared eval quota unilaterally, or declaring an
  impact tier unilaterally were all judged out of bounds here — named as a follow-up ticket
  recommendation (a `social-drafter` AgentDef mirroring `task-filer`'s pattern), not improvised.

**T3b's confirm/expiry/scrub machinery needs ZERO changes to carry a future social intent — verified
by reading the code, not assumed.** `assistant_write_intents`/`confirmWriteIntent`/
`dismissWriteIntent`/the lazy-reap-on-GET path (`write-intents.ts`) are keyed generically on
`tool_call_id`/`tool_name`/`agent` — nothing in that machinery is PM-specific. The day an `ai-agents`
def declares a social `high_write` tool and `ASSISTANT_AGENT_WRITE_TOOLS` gains an entry for it, the
existing confirm/dismiss endpoints, the 1-hour default TTL (`config.assistantIntentTtlMs`), and the
"expiry scrubs `tool_args` to NULL" lazy reap all apply unchanged. **This ticket touched none of
`src/modules/assistant/**`** because none of it needed touching — there is no new agent name to
mirror into `ASSISTANT_AGENT_TOOLS`/`ASSISTANT_AGENT_WRITE_TOOLS` when no `ai-agents` def exists yet.

**The capabilities panel: verified by reading the formula, not hand-registered.** `capabilities.ts`'s
header states it plainly and this ticket confirmed it against the code: `tools` is `visibleToolsFor
(user) ∩ tenant's module gates` — every declared `social.*` MCP tool (all 35 pre-existing + this
ticket's new `social.getEngagementSummary`) appears in the panel by construction once the `social`
module is enabled for a tenant and Cerbos allows the calling user, with zero code added to
`capabilities.ts` for any of them. Only `toolAgents` (the write-turn agent PICKER) is a hand-maintained
mirror — and this ticket adds no entry there, honestly, because it adds no chat-invocable write agent.

**The summary half — "social summary" spanning engagements, posts, inbox threads, metrics, usage —
and how an absent number is never reported as zero.** New `assistant-summary.ts` +
`GET engagements/:engagementId/assistant-summary` + MCP tool `social.getEngagementSummary` (read,
`minAssurance:"low"`, the SAME Cerbos `read` action `listEngagements`/`getEngagementScope` already
use on `social_engagement` — no new permission, no Cerbos edit). Composes: post counts by status
(real counts of our own rows), open/escalated inbox thread counts (same), each connected+in-scope
account's LATEST KNOWN follower reading (reusing `reports.ts`'s `latestKnown`/`sumKnown` verbatim —
`null`, never `0`, when that account's metrics were never pulled), and the engagement's usage
snapshot (`usage-ledger.ts`'s `readUsageSnapshot`, reused verbatim — its own already-correct
`null`-when-tenant-cap-unconfigured is inherited unchanged). Three distinct absences proven, not just
documented: (1) zero `social_metrics_daily` rows for an account ⇒ `followers: null`, `asOfDate: null`
— proven by `(A1)`; (2) a row whose `followers` column is itself `NULL` (the pull ran, that field
wasn't in it) ⇒ still `followers: null` but `everPulled: true` (distinct from "never pulled at all")
— proven by `(A2)`; (3) a REAL zero (no posts, no open threads) renders as an honest `0`, never
withheld — proven by `(A3)`, matching `reports.ts`'s own "counts of our own rows are not subject to
this rule" carve-out.

**A scoping bug found by the tests, not shipped.** The first draft loaded "every CONNECTED account
for this client" for the metrics/inbox halves — a live test (two engagements sharing `clientA`, each
scoped to a different network) caught a same-client account leaking across engagements. Fixed by
re-deriving `content-brief.ts`'s OWN `networks[a.network] === true` filter against the engagement's
`tool_scope.networks` (never re-invented): `social_accounts` belongs to the CLIENT, not the
engagement, so two engagements sharing a client must not have one's summary silently include the
other's accounts/metrics/inbox threads just because they share a client.

**A real node-postgres date bug found by the tests, not shipped.** `social_metrics_daily.date` (SQL
`date`) defaults to node-postgres parsing into a JS `Date` at LOCAL midnight; converting that to
ISO/UTC via `.toISOString()` silently shifts the reported calendar day backward whenever the process's
local timezone sits behind UTC — caught live (a test expecting "today" got "yesterday"). Fixed by
reading the column as `date::text`/`to_char(...)` in SQL and never constructing a JS `Date` from it.

**THE CROSS-CLIENT LEAK TEST, and exactly what it proves.** `assistant-summary.test.ts`'s dedicated
test seeds TWO engagements under DIFFERENT clients (same tenant) with distinctive post titles, inbox
thread counts (1 vs. 2, deliberately different so a swap would be caught, not just a duplicate), and
follower readings (111 vs. 999), drives both summaries back to back against the SAME running app, and
asserts every count, account id, and follower reading in one engagement's response is absent from the
other's, in BOTH directions — proving the per-engagement `client_id`+`tool_scope.networks` scoping
this file adds holds under a live read, not merely in a single-tenant happy path. This is the
harder-than-cross-tenant case the ticket named: two clients under the SAME tenant, exactly where a
missing `WHERE` clause or an unscoped join would leak.

**Test counts: 605 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `d14-smm-17-social-reply-registry.test.ts` + `d14-smm-22-social-metered-publish-registry.test.ts`,
this session's own full run. Baseline directly measured (a fresh full run of the same four-file set,
before this ticket's new file existed in the run): **599 / 0 / 5** — SMM-26's own previously-stated
figure, reproduced rather than trusted blind. **+6 new**, all in the new `assistant-summary.test.ts`
— arithmetic matches exactly (599+6=605). `assistant-summary.test.ts` was ALSO re-run ALONE twice
(once after the scoping-bug fix, once after the date-bug fix) — 6/6 green both times, ruling out the
shared-test-Postgres and cross-test-pollution phantom-failure classes this file names (the SAME two
real bugs above were caught by exactly that "re-run alone" discipline, not by the full-suite run).
`tsc --noEmit` clean on this session's own touched files — `platform-nest/src/modules/social/
assistant-summary.ts`, `assistant-summary.test.ts`, `social.controller.ts`, `index.ts`. The
pre-existing `src/rbac/role-permission-bundles.db.test.ts` failure is another session's uncommitted,
mid-edit file, per this ticket's own briefing — not touched, not this ticket's to fix, and does not
block this measurement. No migration (every read is against 0105's existing tables — no new table,
no ALTER). No Cerbos edit (the one new `authorize()` call reuses the `read` action on
`social_engagement`, already granted to every role that can read the engagement today).
`platform-ui`/`src/rbac/**`/`scripts/generate-role-bundles.mjs`/`src/main.ts` untouched (off-limits
file surface). `src/modules/assistant/**` untouched (see above — nothing needed touching).

**Anything the spec did not answer, named rather than silently decided:** (1) whether `pm.createDoc`/
`task-filer`'s own precedent for "which write tier for chat" generalizes to social is answered above
(yes, structurally — but the ai-agents-side work to act on it is out of this ticket's authority);
(2) whether a future social write-agent should also propose `social.requestClientReview` or
`social.setEngagementScope` (both `impact:"medium"`, both already correctly suspend an automation/
agent caller at the hub) was not evaluated — the ticket named `draftContentBrief` as the interesting
case and this evidence block follows that lead; a follow-up scoping a social write-agent should widen
the tool list at its own discretion, not inherit this pass's narrow read; (3) whether the capabilities
panel should visually distinguish "a tool exists" from "a tool is reachable via a chat write-agent
today" (`tools` vs. `toolAgents` in `capabilities.ts`) is a `platform-ui` question, off-limits here.

**SMM-26 evidence (2026-08-22, senior-be).** Worktree was ONE MERGE BEHIND at cut time — `git log
--oneline -1` did not match local `main`'s tip (SMM-22's own X-metering merge, plus an unrelated
AGN-7 hub commit, had landed) — `git merge main` (fast-forward, clean) pulled `usage-ledger.ts`,
`module-scope.ts` and the SMM-22 metered-publish tool in before any of this ticket's own code was
written, stated rather than assumed, per this file's own repeated cross-session-hazard note.

**The audit, not an assumption — all 34 declared tools, mechanically re-verified, not hand-counted
twice.** `mcp-hub/src/policy.ts#authorize`'s impact gate is the ONLY thing that discriminates among
these tools for an unattended caller: `isUnattended(principal) && tool.write && tool.impact !==
"low"` suspends into WS4 unless a verified D14 grant already covers the call (`grantAuthorizesTool`).
`minAssurance` never discriminates here — all 34 (and the new 35th) are `minAssurance:"low"`, so
every one clears the assurance-rank check trivially for a `low` principal; the classification is
entirely carried by `write`/`impact`. `isUnattended` is `isAutomation(provider) || !!principal.agent`
(`mcp-hub/src/principal.ts`) — and **no `social.*` tool appears in ANY `AUTOMATION_ALLOWLIST` entry**
(`mcp-hub/src/automation-policy.ts`), so the only unattended-caller SHAPE this surface meets in
practice today is an AGENT acting for a human (`principal.agent` set), never a scheduled n8n workflow —
exactly the shape the 2026-08-20 `agent-attribution-gate` fix closed (before it, an agent-driven call
carrying the human's own `provider` skipped the impact gate entirely; after it, `principal.agent`
alone is what makes `isUnattended` true for that caller).

| # | Tool | write/impact | For an `assurance:"low"` automation/agent principal |
|---|---|---|---|
| 1 | `social.listEngagements` | read | Executes — a read is never gated by impact |
| 2 | `social.getEngagementScope` | read | Executes |
| 3 | `social.createEngagement` | write, low | Executes unattended — an empty container, gated separately by `.setEngagementScope`/`.connect` |
| 4 | `social.setEngagementScope` | write, **medium** | **Suspends into WS4** — the money-and-blast-radius dial |
| 5 | `social.listPosts` | read | Executes |
| 6 | `social.createPost` | write, low | Executes unattended — cannot reach a live account without a variant + validation + human approval |
| 7 | `social.addPostVariant` | write, low | Executes unattended — writes per-network content, never dispatches |
| 8 | `social.validateVariant` | read | Executes |
| 9 | `social.importNativePost` | write, low | Executes unattended — bookkeeping for something ALREADY public; can never carry an approval |
| 10 | `social.ingestBrandCorpus` | write, low | Executes unattended — REPLACES the client's knowledge-corpus pointer (see the named finding below) |
| 11 | `social.draftPostVariant` | write, low | Executes unattended — writes a DRAFT row, re-runs validation/hash, never dispatches |
| 12 | `social.draftPostIdeas` | write, low | Executes unattended — `status='idea'` rows only |
| 13 | `social.checkPublishPreconditions` | read | Executes — dry-run only, no network call, consumes no approval |
| 14 | `social.requestClientReview` | write, **medium** | **Suspends** — the FIRST moment a variant becomes visible outside the tenant |
| 15 | `social.getClientReview` | read | Executes |
| 16 | `social.withdrawClientReview` | write, low | Executes unattended — purely corrective, never notifies the client |
| 17 | `social.publishPost` | write, **high** | **Suspends** — THE D14 gate; reachable in the ordinary flow only through the executor's re-drive |
| 18 | `social.publishPostMetered` | write, **high** (spread from the SAME constant) | **Suspends** — identical to #17, plus barred from auto-exec by default regardless (`meteredPublishEnabled`) |
| 19 | `social.getUsage` | read | Executes — makes no network call, consumes no budget |
| 20 | `social.createReplyDraft` | write, low | Executes unattended — a draft reply, never sent, never network-visible |
| 21 | `social.updateReplyDraft` | write, low | Executes unattended — edit invalidates any existing grant (D-15) |
| 22 | `social.approveReplyDraft` | write, low | Executes unattended — bookkeeping sign-off on OUR OWN row, not the outbound act |
| 23 | `social.checkReplySendPreconditions` | read | Executes |
| 24 | `social.sendReply` | write, **high** (spread) | **Suspends** — same D14 shape as `publishPost`, reusing the identical classification |
| 25 | `social.listAccounts` | read | Executes — never calls the publisher |
| 26 | `social.getPublisherStatus` | read | Executes — makes no network call |
| 27 | `social.provisionPublisherOrg` | write, **medium** | **Suspends** — the wrong-account-publish-nightmare row |
| 28 | `social.syncConnectorRegistry` | write, low | Executes unattended — mirrors STATE ABOUT connections that already exist, never a token |
| 29 | `social.draftReport` | write, low | Executes unattended — `status='draft'` only, no client visibility |
| 30 | `social.listReports` | read | Executes |
| 31 | `social.getReport` | read | Executes |
| 32 | `social.editReport` | write, low | Executes unattended — internal narrative edit / submit-for-review, no client visibility |
| 33 | `social.approveReport` | write, low | Executes unattended — internal staff sign-off, never the client-visible act (delivery is #34) |
| 34 | `social.deliverReport` | write, **medium** | **Suspends** — outward-facing and unretractable, same ground `search.deliverReport` uses |

**Tally: 12 reads, 15 low-impact writes (all draft rows / knowledge pointers / mirrored registry
state, none reach a live network), 4 medium-impact writes (all correctly suspend), 3 high-impact
writes sharing ONE pinned classification constant (all correctly suspend, all unreachable in the
ordinary flow except through the D14 executor's own re-drive). 12+15+4+3 = 34.**

**Verdict: the invariant already held. Nothing was reclassified.** Every write that can put content
in front of a client, spend money, or reach a live network is `impact` ≥ `medium` and suspends an
unattended caller. Every `impact:"low"` write is confined to our own rows (drafts, mirrored
registry state, a knowledge-corpus pointer) with no path to a network call.

**One finding, named rather than silently fixed or silently ignored: `social.ingestBrandCorpus`'s
own REPLACE semantics.** `knowledge-client.ts#ingestBrandKnowledge` REPLACES the client's entire
brand-voice corpus on every call (WS8's own D9.2 upsert-by-scope contract) and hardcodes
`provenance: "human"` on every ingested chunk — a label that is TRUE when a human pastes approved
copy into the endpoint, and NOT verified true when an agent calls the SAME tool with its own
generated text (nothing stops that — the endpoint accepts any `chunks: string[]`). This is a
DATA-PROVENANCE finding, not a D14 authz hole: `write:true,impact:"low"` is still the right
classification (the blast radius is "future drafts ground on possibly-agent-authored text," not a
live-network act or client exposure), so no reclassification is warranted, and D-13's binding design
(WS8 owns the corpus; this module stores only pointers) means a provenance-tagging fix touches a
schema/contract WS8 and this module both need to agree on — outside a single ticket's authority to
improvise. Named here and in `knowledge-client.ts`'s own header for whoever next touches that file.

**The `smm-agent-content-brief` flow — "brief in, drafts out, nothing published."** Built in
`platform-nest` (new `content-brief.ts`), not n8n. Composes SMM-19's own `draftPostIdeas`/
`draftPostVariantCaption` paths into ONE call: N idea posts (`source='agent'` — 0105's own
`social_posts.source` CHECK has admitted `'agent'` since SMM-01, unused until now; an HONEST
distinction from `draftPostIdeas`'s own `source='ai'`, since nobody prompted any one of these ideas
directly) — count defaults to the engagement's OWN `tool_scope.posting.cadencePerWeek`, never an
invented number — each with one caption-drafted variant per connected account whose network the
engagement has enabled (or an explicit `accountIds` subset). New MCP tool `social.draftContentBrief`
(`write:true,impact:"low"` — the SAME ground `draftPostIdeas`/`draftPostVariant` already stand on).
New endpoint `POST engagements/:engagementId/agent-content-brief`; `authorize()` calls the SAME TWO
actions (`create` on `social_post`, `update` on `social_post`) a caller composing this by hand
through the existing granular tools would already trigger — batched once each per request, the SAME
batching `draftPostIdeas` itself already uses for its own `create` check across N created rows.

**Why NOT the v1.0 design's n8n-scheduled "weekly per opted-in engagement" sweep — reasoned, not
skipped.** `smm-design.md` §10 named this flow as an n8n-triggered "WS8 agent goal" (image generation
dropped by the addendum, D-17). Three precedents in THIS module (SMM-15/16/17's `inbox-sync-job.ts`/
`inbox-triage-job.ts`) already established that despite that same design table's own framing, this
module's periodic sweeps live in `platform-nest` as scheduled loops, not n8n workflows — followed
here too, for consistency. But a genuinely scheduled, PRINCIPAL-LESS sweep cannot legitimately call
WS8's own per-principal-scoped `/search` (`knowledge-client.ts`'s own header: the tenant pre-filter
needs a resolvable caller identity via OBO) without either shipping permanently-ungrounded drafts or
borrowing a human's identity dishonestly — the same "honest attribution" property SMM-16's own
`actor_id NULL` fix established for job-driven writes. **Named as a follow-up requiring an architect
decision on an automation service identity for RAG-grounded scheduled jobs generally — not
improvised here.** What ships instead is the ON-DEMAND, principal-driven MCP tool/HTTP endpoint,
which gets FULL RAG grounding via the caller's own OBO userId, exactly like every other AI-drafting
endpoint in this module.

**Idempotency and "never a silent $0", both proven, not asserted.** Idea posts are idempotent via the
SAME caller-supplied `ids` array `draftPostIdeas` already supports. Variants have no equivalent
caller-supplied id (an N-ideas × M-accounts request has no natural per-pairing id to expose) —
idempotency instead rests on checking whether a variant ALREADY EXISTS for (postId, accountId)
BEFORE ever calling the gateway or writing a row: proven by driving the SAME request twice with the
SAME idea `ids` and asserting the retry's variant is reported `created:false, draftedVia:"existing"`
with NO second caption-drafting prompt sent. `estimateCostUsd` is computed BEFORE a variant is
written, exactly like `createVariant`'s own discipline (defect class #4) — an X pairing with no
configured price is skipped and counted (`variantsSkipped.unpriced_network`), proven by seeding a
connected `x` account with no `SOCIAL_X_PER_POST_COST_USD` configured and asserting zero rows land
for that pairing. A self-imposed `config.social.contentBrief.maxVariantsPerCall` (default 20) bounds
one call's own (idea × account) gateway-call volume — proven by setting it to 1 against 2 enabled
accounts and asserting exactly 1 variant is created, 1 reported `call_volume_cap`.

**THE CROSS-CLIENT LEAK TEST, and exactly what it proves.** Unlike SMM-19's single-item
`draftPostVariantCaption`, this flow drafts MULTIPLE ideas × accounts in ONE call — the NEW risk this
ticket introduces is a batching bug that lets one iteration's grounding facts leak into another's
prompt, not (only) the cross-tenant-search risk SMM-19's own test already covers. `content-brief.
test.ts`'s dedicated leak test seeds TWO DIFFERENT clients under the SAME tenant with distinctive
corpus markers, runs the flow for BOTH back to back against ONE shared mocked gateway/knowledge
transcript, and asserts every prompt containing one client's marker NEVER contains the other's, in
BOTH directions, across the WHOLE transcript (idea-generation AND caption-drafting prompts alike) —
proving (a) SMM-19's existing per-call WS8 scope isolation still holds through this new composite,
and (b) this file's own per-idea/per-variant loop never accumulates a shared prompt or a shared
knowledge-hit list across iterations, which is the property unique to this ticket's new N×M
orchestration. Every WS8 `/search` call in the transcript is also asserted to have asked for exactly
one client's own scope, never the other's.

**`mcp-hub` gap found but not fixed: none.** The read-only audit found the existing impact-gate
mechanism already sufficient for this entire 34-tool surface; there was no hub-side change to report
as a gap.

**Anything the spec did not answer, named rather than silently decided:** (1) the scheduled/n8n half
of the flow (see above); (2) `social.ingestBrandCorpus`'s provenance-labeling finding (see above);
(3) whether an agent-driven content brief should notify anyone when it lands (SMM-31's own
`social.client_review.requested` notification precedent does not apply here — nothing here is
client-visible yet) — left unbuilt, since nothing in the addendum asks for one and inventing a
notification channel felt like exactly the "silent half-feature" this program's own discipline warns
against.

**Test counts: 599 / 0 / 5** across `src/modules/social` + `d14-smm-09-social-publish-registry.test.ts`
+ `d14-smm-17-social-reply-registry.test.ts` + `d14-smm-22-social-metered-publish-registry.test.ts`.
Baseline **measured directly by stashing**: `git stash -u` cleanly stashed both modified and new/
untracked files, the four-file set was re-run against the clean tree and came back **591 / 0 / 5** —
matching SMM-22's own previously-stated figure exactly, so trusted rather than re-litigated. Popped
clean, all five touched/new files restored intact. **+8 new**, all in the new `content-brief.test.ts`
— arithmetic matches exactly (591+8=599). `content-brief.test.ts` was ALSO re-run ALONE twice (before
and after two test-only fixes — a wrong expected caption-body string and a `prompts` array not
cleared before a retry assertion, both test bugs, not implementation bugs) — 8/8 green both times,
ruling out the shared-test-Postgres and in-process shared-mock phantom-failure classes this file
names. `tsc --noEmit` clean. `lint:withtenants`/`lint:migration-rls`/`lint:migration-names`/
`lint:postiz-deps` all green (no migration — still 130 files). `test:iam-chain-alignment` **25/25** —
no Cerbos policy or catalog change; every permission (`social.post.{create,update}`) and Cerbos
action this ticket's new endpoint uses already existed and was already catalogued (0106).
`platform-ui` untouched (off-limits file surface this ticket).

## Decision-gated — do not mobilise

| # | Ticket | State |
|---|---|---|
| SMM-28 | Mixpost Pro swap | ☠ **DEAD** — free-only constraint + D-20 |
| SMM-29 | ClipsAI video repurposing (OQ-6) | ⬜ gated |
| SMM-34 | Generative images | ⬜ gated on `render-gateway-go` leaving `0.0.0` |

---

## Open items not owned by any ticket

| Item | Owner / when |
|---|---|
| **`ingestBrandCorpus` labels every chunk `provenance: "human"` regardless of caller** (`knowledge-client.ts:90`, comment reads *"caller-supplied approved content, not agent-generated"*). True for a human pasting approved copy; **unverified for an agent**, and `social.ingestBrandCorpus` is a declared MCP tool an automation principal can call at `impact:"low"`. Not a D14 hole — no live-network path — but the brand-voice corpus is what **grounds every future draft**, so AI text mislabelled as approved human copy becomes a feedback loop: the model cites its own earlier output as the client's voice. Found by SMM-26's audit, correctly named as a schema/contract question WS8 and this module share rather than improvised | WS8 + senior-be |
| **`social_inbox_messages.source` mislabels every inbound row.** `0105`'s CHECK admits only `('postiz_sync','reply')`, so a LinkedIn comment pulled through the `direct` driver is stored as `'postiz_sync'` — and Postiz has **zero inbound surface** (OQ-4), so it can never actually be the source of an inbox message. Every inbound row is wrong by construction. SMM-15 called it a naming quirk; it is a provenance column telling a lie, and **SMM-16's triage and SMM-18's UI will read it**. Fix is a migration widening the CHECK (e.g. `'direct_sync'`, or per-driver) plus a backfill — small, but do it BEFORE anything branches on the value | small ticket, before SMM-16 |
| **`metrics-job.ts` reads `process.env` directly rather than `config.ts`** — the seat was held out of `config.ts` to avoid a three-way collision, so `SOCIAL_METRICS_PULL_ENABLED`/`_INTERVAL_MS` are the only social knobs not visible where an operator greps for them. Harmless today, drift tomorrow | small cleanup |
| ~~AGPL §13 source-offer has nowhere to live~~ — **CLOSED 2026-08-21 (senior-uiux), built, not merely recommended.** New `platform-ui/src/components/social/SourceOfferNotice.tsx`, rendered from `departments/[deptId]/layout.tsx` gated on `toolkit.slug === "social-media"` (the same `toolkitFor` value the layout already resolves, robust to whatever id/name the org structure assigns — the exact robustness `deptSlug`/`toolkitFor` already gives every other consumer). **Placement decision, made rather than deferred to the owner: the SOCIAL department's own console, not the generic staff shell the prior pass recommended.** Rejected `(app)/layout.tsx` (the prior seat's own recommendation) because it wraps EVERY staff page — HR, IT, PM, admin, none of which ever call Postiz — and a Postiz notice in front of people it has nothing to do with is its own kind of dishonesty, the same failure mode as the wrong-audience client-portal footer the prior pass already ruled out. The department console's `[deptId]/layout.tsx` already computes `toolkit` from `dept.name` for the tab strip; gating the notice on `toolkit.slug === "social-media"` reuses that exact resolution rather than inventing a second one, and reaches every tab this department has (Home/PM/Publish group's Calendar-Composer-Inbox-Analytics/Connections) including the full-bleed Calendar branch of `DeptShellFrame`, which renders a structurally different DOM tree from the 2-col branch — both were driven, both carry it. **Wording contract (the copy never names a version):** the sentence promises "the source for exactly what we run," never "unmodified" — a claim that would go silently false the day D-21's fork exception (TikTok `creator_info` + the IG quota probe, ~15 lines, granted but not yet applied) lands. Only the link target has to move then, from the upstream repo to wherever the patched source is published (a public fork/mirror — this console's own non-engineering staff need a reachable link, not a private-repo path); the component's own header comment states this in the same words, so it isn't a second, undocumented gap. **Driven in a real browser** (`DEMO_MODE=1`, headless Chromium, manager identity, `co-agency` tenant — `dept-4` is Social Media in the seeded org structure): footer present with the correct text and a resolving link (`https://github.com/gitroomhq/postiz-app`) on the department's Home, Calendar (full-bleed), and Composer tabs; **absent** on `dept-1` (Web Dev), confirming the gate. `npx tsc --noEmit` clean. No new test file (a static presentational component + one conditional render; `platform-ui` full suite unchanged at 2444/0/0 both with and without the change, measured directly by stashing). Accessibility: real `<a>` (not a div/onClick), explicit underline (not colour-only, inline prose link — WCAG 1.4.1), inherits the global `:focus-visible` ring, body text on `--ink-muted` (6.2:1, chosen over the client-portal footer's own `--ink-faint` at 3.3:1 — decorative-only per its own token comment, not fit for a legal notice), `role="note"` + `aria-label="Open-source notice"` landmark. No new dependency | closed |
| Platform-app reviews — **Meta first**, its Business Verification is the only serial prerequisite | **staging** (D-23) |
| Google SSO on Postiz login: does `DISABLE_REGISTRATION` block a *first-time* sign-in? | staging checklist — **do not test on the live instance** |
| Postiz OAuth finalization route — "reasoned from source, not yet driven" | whoever first holds a live app credential |
| AGPL counsel sign-off before any client account connects (OQ-3) | owner |
| Fork exception **D-21 granted but not applied** — TikTok `creator_info` + IG quota probe (~15 lines) | unscheduled |
| ~~rbac artifact CRLF~~ — **CLOSED 2026-08-19 by another session**: `.gitattributes` now pins `platform-nest/src/rbac/*.json` to `eol=lf`, same fix as the `*.sh`/`*.go` entries | done |

## Owner decisions — do not relitigate

| # | Decision |
|---|---|
| OQ-2 | X ships **disabled** — keeps the publish path $0 and D14-registry-eligible |
| OQ-5 | Media rides `files` + Drive mirror |
| OQ-7 | Postiz runs on the SumoPod VPS, not `gda-aicenter` |
| D-16 | Client post-approval builds in P2, on a plain-tenant-wall table |
| D-17 | Image generation deferred — no generative backend exists |
| **D-20** | Build the `direct` driver now; Postiz is the incumbent, not the destination |
| **D-21** | Fork exception granted **once**, both items in scope |
| **D-22** | Composer selections ARE TikTok consent; `creator_info` re-verified at dispatch |
| **D-23** | Platform-app reviews **deferred to staging** — a phase boundary, not a blocker |

---

## Security follow-ups closed (2026-08-23, senior-be)

Two of the "small follow-ups the seats named rather than silently absorbed" (below), both closed in
one pass. Neither was speculative; both were named honestly by the seats that shipped the code they
sit in.

**A — OAuth state single-use (SMM-38c/38d's own named gap).** `linkedin-oauth.ts`/`youtube-oauth.ts`
minted an HMAC-signed, time-boxed `state` with NO database row and NO atomic single-use enforcement
— both files' own headers said so explicitly, and flagged a DB-backed table as "a follow-up, not
silently decided as unnecessary." Closed:
- New table `social_oauth_states` (`migrations/202608221751_social_oauth_states.sql`) — THIRD RLS
  wall, byte-identical predicate to `social_oauth_tokens` (202608201519); reasoned deliberately
  tenant-scoped (not core, unlike `google_oauth_states`/0076 — nothing outside `social` mints or
  consumes this shape); purges EVERY row (consumed or not) past `expires_at`, a documented departure
  from `google_oauth_states`' own keep-consumed-forever policy since this table's consumed rows carry
  no comparable audit value (`social_accounts`/`social_oauth_tokens` already record it durably).
- New shared module `publisher/oauth-state.ts` — `parseSocialOAuthStateToken` (sync, HMAC-only, no
  DB, for the pre-authorize tenantId check) + `consumeSocialOAuthState` (async, the atomic
  `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING`), mirroring
  `core/google-oauth/state.ts`'s own proven mint/parse/consume split rather than inventing a second
  scheme. Both callback controllers updated: parse → Cerbos `connect` check → consume → complete.
- **RED (captured before the fix, then reverted):** `git stash` on the six changed files restored
  the ORIGINAL `linkedin-oauth.ts`; a throwaway test minted one state and called
  `parseLinkedInOAuthState` on it three times — **all three succeeded identically**
  (`{tenantId:"tenant-1",accountId:"account-1"}` every time), proving no single-use enforcement
  existed. `git stash pop` restored the fix; the probe file was deleted (not committed).
- **GREEN:** `oauth-state.test.ts`, **10/10 passed**. Covers: mint→consume round trip; a SECOND
  consume of the same token refused (`SocialOAuthStateError`, reason
  `unknown_expired_or_consumed`), including three further replay attempts, all refused identically;
  two CONCURRENT consume attempts on the same token — exactly one wins (`Promise.allSettled`, 1
  fulfilled / 1 rejected — the atomic UPDATE, not check-then-act); tampered signature
  (`bad_signature`); malformed token; expired-but-unconsumed (same collapsed reason as a replay, by
  design — never a state-existence oracle); network-mismatch (a linkedin state presented at the
  youtube consume call is refused AND burned by that presentation — a retry against the correct
  network then replays); cross-tenant isolation; the `oauth_states` purge seam (deletes a
  consumed-and-expired row, alongside the built-in `inbox` purger in the same transaction).
- **Found and fixed in the same pass (not asked for, but directly "never a generic 500"):**
  `YouTubeOAuthStateError` was never added to `main.ts`'s global filter list — only
  `LinkedInOAuthStateError` was. A malformed/forged/expired YouTube callback state escaped as a
  **body-less 500** (the exact bug class platform-nest's CLAUDE.md names as having recurred four
  times). Consolidating both networks onto one `SocialOAuthStateError` (registered once) closes this
  by construction — there is no longer a second class to forget.
- **Named, not fixed (out of scope):** `created_by` is stored on the new table for audit but not
  compared against the calling principal at consume time — `core/google-oauth/state.ts`'s own
  login-CSRF defense (`principal_mismatch`) does that comparison; this table does not yet. A small,
  separate follow-up.
- Full platform-nest social suite re-run: **531 passed / 0 failed / 5 skipped** (36 files; the 5
  skips are `social-reports.test.ts`'s own pre-existing, unrelated self-skip). `tsc --noEmit` clean.
  `npm run lint:migration-names` / `lint:migration-rls` both green (134 files scanned).

**B — SMM-22's Cerbos gap for an agent/automation-origin metered-tool re-drive.** Stated plainly,
per this ticket's own instruction not to invent work: **this was NOT a live authorization hole.**
Live-probed against a standalone Cerbos (`ghcr.io/cerbos/cerbos:0.54.0`) serving this worktree's
UNMODIFIED `resource_mcp_tool.yaml`, via `POST /api/check/resources`:
- An n8n/automation-origin principal (`isAutomation:true`, in the tool's own `automationScope`,
  `assurance:"low"`) calling `social.publishPostMetered` (`write:true`/`impact:"high"` since SMM-22
  gave it a real endpoint) WITH a plausible `approvalId` attribute → **EFFECT_DENY**.
- An agent-origin principal (`isAutomation:false`, `isUnattended:true` via the agent marker,
  `assurance:"low"`) with the SAME shape → **EFFECT_DENY**.
Both denied simply because the tool's name is absent from the policy's executable-tool bracket —
D14-13's grant-lift disjunct cannot fire without a bracket entry, and nothing else in the policy
would let an unattended, high-impact write through. **What was actually missing**: any
SMM-22-specific documentation of this exclusion (the file's only relevant prose predated SMM-22's
real tool declaration and had gone stale — the identical staleness independently found in
`modules/social/index.ts`'s own import-block comment, "stays undeclared and barred", fixed in the
same pass) and any regression test proving the denial for this real tool name. Closed:
- A dated SMM-22 block added to `resource_mcp_tool.yaml`, naming `social.publishPostMetered`
  explicitly, explaining the money-spending reasoning, and warning against ever adding the name to
  the bracket without the separate, reviewed runbook step `core/approval-executables.ts`'s own
  header already names for turning `SOCIAL_METERED_PUBLISH_ENABLED` on.
- Five new LIVE-Cerbos tests in `mcp-hub/src/cerbos.test.ts` (against the REAL tool name, hand-
  registered with its real classification, not a synthetic stand-in): automation-origin DENY with a
  verified grant (proving the in-code engine ALONE would have allowed it — only the policy's
  explicit list still refuses); agent-origin DENY with a verified grant; both origins' DENY with NO
  grant (today's unchanged suspend behaviour, pinned so a future edit cannot silently flip it); and a
  verified HUMAN's own direct call is unaffected (ALLOW, D14 never applied to an attended caller).
- Full mcp-hub suite: **273 passed / 0 failed** (20 files, includes the 5 new tests — up from the
  pre-existing 29 in this same describe block). `tsc --noEmit` clean. Cerbos policy compiled clean
  (`docker run ghcr.io/cerbos/cerbos:0.54.0 compile /policies`) both BEFORE and AFTER the edit — the
  edit is comment-only, no CEL/rule change, so this also demonstrates the folded-scalar `//`-comment
  trap this exact file broke on once (2026-08-20) was not repeated.
- `npm run test:iam-chain-alignment` (platform-nest): **25/25 passed** — no permission-catalog/Cerbos/
  module-declared-permission drift introduced (no permission NAME changed).

---

## What is actually left (2026-08-22, updated same day by SMM-26's own pass)

**38 tickets merged.** P0, P1, P2, P3, the whole `direct`-driver wave, and SMM-26 (the first P4
ticket) are all closed. Module `0.5.16`; `src/modules/social` + the three
`d14-smm-{09,17,22}-social-*-registry.test.ts` files 599/0/5 (this pass's own directly-measured
figure — see SMM-26's evidence block below for the full arithmetic). `platform-ui` untouched this
pass (off-limits file surface), still 2592/0/0 per SMM-22's own figure.

| Remaining | Note |
|---|---|
| **SMM-22 follow-ups** | Usage panel not browser-driven (unit/type-checked only); ~~`resource_mcp_tool.yaml` not updated for the agent/automation-origin metered-tool re-drive case~~ **CLOSED 2026-08-23, senior-be — see "Security follow-ups closed" evidence block above** (was already correctly denied; closed as documentation + regression test); X's real billing trigger (request-acceptance vs. confirmed-publish) is unverified against a live account (D-23) |
| **SMM-25** full-stack e2e | 🟡 partial, and permanently so until D-23 clears — the DEMO_MODE Playwright console suite landed this pass (13/13); the LIVE half cannot be built by anyone today (no credential exists anywhere in the estate) |
| **SMM-26 follow-up** | the v1.0 design's "weekly per opted-in engagement" scheduled sweep for the content-brief flow was deliberately NOT built — needs an architect decision on an automation service identity before a principal-less job can legitimately call WS8's per-principal-scoped RAG search |
| **SMM-27** | ✅ merged 2026-08-23 — see this file's own SMM-27 evidence block (P4 table above); the last unbuilt ticket in the department |
| **SMM-35** | 🟡 partial — assistant "social summary" read landed; no social write reachable from `/assistant` this pass (own named cross-repo gap) |
| **SMM-29 / 34** | Decision-gated (ClipsAI; generative images, waiting on `render-gateway-go` to leave `0.0.0`) |

**Small follow-ups the seats named rather than silently absorbed:**
- ~~`social.client_review.withdrawn` has no registered event handler, unlike `.requested`/`.decided`~~
  — **CLOSED 2026-08-23** (module `0.5.19`). `handleClientReviewWithdrawn` added and registered; the
  write path now carries `clientId`/`projectId`/`postTitle` on the event via the same third-walled
  join `requestClientReview` uses. The real-world defect was not the missing function but the
  missing *registration*: `.requested` left a live bell entry aimed at a row the client could no
  longer see once the ask was withdrawn, so the client saw a vanished item rather than a retraction.
  Proven red-then-green — deleting the registration line turns the new pin in `client-review.test.ts`
  red with its own diagnostic. Note the pre-existing `arrayContaining` assertion in that same file
  stayed GREEN throughout the entire period the handler was missing: a non-exhaustive registration
  check is not a registration check. Worth remembering for the other handler maps in this module.
  Deliberate non-change: `social.withdrawClientReview` stays impact `'low'` (its comment cited
  "never notifies the client", which is now false — corrected in place, with the surviving ground
  being that a withdrawal notice creates no NEW outward exposure).
- ~~`metrics-job.ts` reads `process.env` directly instead of `config.ts` (it was held out of that file to avoid a three-way collision)~~
  — **CLOSED 2026-08-23** (module `0.5.22`). Gate moved to `config.social.metricsPull`; it was the
  only job in the module not gated there. The two env-mutating tests were REMOVED rather than ported:
  `config.ts` is evaluated once at import and `main.ts` reads the flag once at boot, so a test that
  set an env var and expected the value to follow would assert behaviour the real boot path does not
  have. Replaced with assertions on the config surface, including one pinning that the flag is a real
  boolean — a bare `Boolean(process.env.X)` reads the string `"false"` as ON.
- ~~The report narrative has no runtime numeric guard — only the prompt constrains a hallucinated figure~~
  — **CLOSED 2026-08-23** (module `0.5.20`). `findUngroundedNumbers` traces every digit-run in the
  narrative back to a grounding fact; an untraceable number REJECTS the AI draft in favour of the
  deterministic fallback. The old reasoning ("nothing can strip a hallucinated number out of prose")
  was true but answered a different question — prose cannot be repaired, yet it can be declined.
  Strict by choice: "the top 6 posts" is rejected though not wrong, because a false positive costs a
  dull narrative and a false negative puts an invented figure in front of a client. `rejectedNumbers`
  is recorded on the activity row so a rejection is distinguishable from a gateway hiccup (both are
  `draftedVia:'fallback'`) and so the false-positive rate is observable rather than assumed. Wire
  contract untouched.
- ~~The print page's `CompanyCharts` does not know this document's series/table keys, so a rendered PDF carries KPIs and narrative but not series~~
  — **CLOSED 2026-08-23** (`reports 0.3.2`, not a social version — the defect and the fix both live in
  the shared reporting kit, `platform-ui/src/components/reports/GrainCharts.tsx`). Fixed for the CLASS
  rather than for social: instead of adding social's four keys to the allowlist (which breaks again
  for the next producer), anything the grain-specific composition did not consume is now rendered
  generically, in all four grains. Ratio series and empty series are deliberately excluded — a ratio
  charted alone sums per-bucket percentages (average-of-averages), and an empty frame implies zero.
  Proven red-then-green.
- ~~OAuth state is HMAC-signed and time-boxed but not DB-backed single-use~~ **CLOSED 2026-08-23,
  senior-be — see "Security follow-ups closed" evidence block above** (`social_oauth_states` +
  `oauth-state.ts`, RED-then-GREEN proven)
- ~~Spike detection has no persistent dedup, so a sustained spike re-fires each tick~~
  — **CLOSED 2026-08-23** (module `0.5.21`). The dedup state is the `outbox_events` log itself: every
  emit is already durably recorded, it is never pruned, and `idx_outbox_events_entity` already indexes
  the exact lookup — so no new table, and no second store of "did we already say this" to keep in
  agreement with the log that decides what was emitted. Cooldown is DERIVED
  (`spikeWindowMinutes * (spikeBaselineWindows + 1)`, the point the burst ages out of its own
  baseline) rather than a fresh constant, per this module's convention that these thresholds must
  never read as measured. `spikes` and `suppressed` are counted SEPARATELY — collapsing them would
  make a sustained spike look like it had stopped. Proven red-then-green.
- `listComments`'s `urn:li:` prefix heuristic would need a real `network` parameter if a third network's ids ever collide
- No publish "approve variant" endpoint exists anywhere in the codebase (pre-existing, found by SMM-17)

**Not ours to finish:** the platform-app reviews (D-23 — Meta's Business Verification is the only serial
prerequisite), the D-21 fork exception (granted, unapplied), and whether `DISABLE_REGISTRATION` blocks a
first-time Google SSO sign-in on Postiz's login page. **Every platform app credential in the estate is
empty**, so nothing in this module touches a live network until those land.

## Recurring defect classes — check every ticket against these

**1. The module GUC (four occurrences).** Every `social_*` table carries `0105`'s third wall
`app_module_allowed('social')`, which `withTenants([tenantId])` does **not** satisfy. Without
`declareSocialModuleScope`, queries read **zero rows and raise nothing**. It produced: a gate that
would refuse every healthy publish · a purge job reporting "0 purged, all clean" forever · a status
sync applying nothing · event handlers routing nothing. **Every new `social_*` query path needs a
regression test that fails if the declaration is removed.** SMM-31 added a fifth and sixth
occurrence deliberately-tested-around: `evaluateClientReviewPrecondition` (self-declares, additively
and idempotently, exactly like `evaluatePublishPrecondition`) and the new portal controller's
`decide()` (declares explicitly, since portal controllers carry no `{modules}` option by
convention) — both regression-pinned by temporarily deleting the call and watching the
corresponding test fail (`client-review.test.ts`'s "(R1) REGRESSION", 
`social-client-review-portal.controller.test.ts`'s header note). SMM-38/38b added three more:
`storeOAuthGrant`/`resolveActiveAccessToken`/`revokeOAuthGrant` (`oauth-tokens.ts`) each self-declare
the same way, each pinned by a test that opens the transaction with NO `{modules:['social']}` option
(`oauth-tokens.test.ts`'s "(1) THE MODULE-GUC REGRESSION" block) — a token table silently reading
zero rows would mean "no grant found" for an account that plainly has one, or worse, "nothing to
refresh, all clean" forever while a grant sits unrefreshed. The ONE function in that file that does
**not** self-declare, `purgeOAuthTokens`, is deliberate (it runs inside the already-scoped
transaction `purgeTenantInboxRetention` opens, per SMM-36's own purger contract) and is pinned by the
inverse test: calling it directly on an unscoped transaction must read zero rows. SMM-38c's
`linkedin-oauth.ts` (`startLinkedInConnect`/`completeLinkedInConnect`) uses the SAME
`withTenants([tenantId], fn, MODULES)` call-site shape `social-reports.controller.ts` uses (never
`declareSocialModuleScope` inline) — not pinned by a dedicated "delete the option and watch it fail"
test this pass, but every existing assertion already depends on the option being present: the
start→complete round-trip test asserts a REAL `connected` row and a REAL resolvable token
afterward, which reads back "0 rows"/`oauth_token_not_found` the instant `MODULES` is dropped from
either call — the same shape SMM-31/SMM-23's own regression tests rely on.
`social-client-review-portal.controller.test.ts`'s header note). SMM-23's `social-reports.controller.ts`
uses the SAME `withTenants([tenantId], fn, { modules: ["social"] })` shape every other route in this
file uses (never `declareSocialModuleScope` inline, since every query runs through that one option
at the `withTenants` call site) — pinned the same way as the module's other endpoint-level GUC calls:
by asserting a real, readable row after create/list/detail/deliver, the shape that would silently
regress to "zero rows, looks perfectly healthy" if the option were dropped from any one query.
`social-client-review-portal.controller.test.ts`'s header note). SMM-20 drew the SAME boundary in
the OPPOSITE direction on purpose: `files`/`creative_assets` are read/written by its new
asset-library endpoints with **NO** `{modules:["social"]}` at all, because neither table carries
`0105`'s module wall — gating them would silently zero out reads for any tenant, module-enabled or
not, since the wall those tables actually carry is the plain tenant wall only. Its own new
`social_post_variants`/`social_engagements` queries DO carry the declaration, proven by tests that
assert a materialized `files` row, a changed `args_sha256`, and a real status transition — not a
`.resolves.not.toThrow()`. SMM-26's new `content-brief.ts` self-declares in EVERY one of its own
`withTenants` transactions (engagement read, account resolution, recent-posts read, idea write,
per-pairing existence check, variant write) — the SAME `declareSocialModuleScope` idiom `dispatch.ts`/
`reply-dispatch.ts` use rather than a caller-supplied `{modules:['social']}` option, since this file
(unlike the controller) has no `withTenants` call site it can guarantee carries one. Not pinned by a
dedicated "delete the call and watch it fail" regression this pass, but every one of
`content-brief.test.ts`'s own assertions already depends on the declaration being present: a real
`social_posts`/`social_post_variants` row materializes and is read back after every call, which reads
"0 rows, idea/variant never created" the instant any one `declareSocialModuleScope` call is dropped —
the same shape SMM-23/SMM-38c's own un-pinned-but-load-bearing GUC calls rely on.

**2. Registered but never invoked (one occurrence).** `main.ts`'s `startConsumerLoop([...])` omitted
`"social_post_variant"`, so SMM-13's handlers existed, were registered, and were never reached. Its
own suite was green because it called them directly. **Verify the caller, not just the callee.**
SMM-31's two new event routes (`social.client_review.requested`/`.decided`) deliberately ride the
SAME already-drained `"social_post_variant"` stream rather than adding a new entity-type name, to
avoid ever needing to remember a `main.ts` change for them.

**3. Tests that pass while the feature is dead.** Two shipped this week: `.resolves.not.toThrow()`
assertions that survive deleting the function body, and reads through `withTenants([])` — an empty
tenant scope reads zero rows under RLS, making "nothing was sent" assertions vacuous. `mail_log` must
be read via `adminPool()` and `config.mail.enabled` flipped in-test.

**4. A skipped suite reporting green.** SMM-36 passed typecheck, lint and 1810 repo tests while all
nine of its DB tests silently skipped for want of `DATABASE_URL_TEST` — and shipped a purge job that
was dead on a type-inference bug. **Any seat touching migrations or DB-backed jobs gets the test-DB
URL, and the acceptance-critical suites get re-run at merge.**

**4b. A stale comment beats the code, if you let it.** `index.ts` carried an SMM-09 comment saying
`social.publishPost` was NOT declared as an MCP tool. SMM-10 declared it ~40 lines below, using the
`SOCIAL_PUBLISH_TOOL` constant so the name is never retyped. A later seat grepped for the literal
string, found nothing, read the comment, and reported the tool undeclared — and `FRONTEND-BFF-CONTRACT.md`
said the same stale thing. Both corrected 2026-08-20. **Grep for the constant, not the literal, and
trust the code over the prose.**

**5. In-process tests are silent about bundling.** `demoSocial.ts` mutated a plain module array; Next
bundles the `"use server"` action graph and the RSC read graph separately, so the write and the read
saw different copies. A vitest passed by construction — one module instance. **Only a real browser
against a real server can see this class.** Mutable DEMO_MODE stores pin to `globalThis`.

**6. `healthy` is not `working`.** Postiz's healthcheck probes only its frontend; with the backend
dead every call 502s while the container reports healthy. And the ERP's own publisher treats a missing
base URL as a *supported* mode — 200s everywhere, publish refusing 503. **Prove with a call that
expects a specific status.**

**7. A shared, stateful module-level mock pollutes across `it()`s in FILE DECLARATION ORDER, not
insertion-time-of-writing order (SMM-38e closing pass, 2026-08-21).** `direct.test.ts`'s top-level
`const unreachableFetch = vi.fn(...)` is used by several cases; ONE pre-existing case asserts
`expect(unreachableFetch).not.toHaveBeenCalled()`. A new case, added into a describe block placed
EARLIER in the file than that assertion's own describe block, called `unreachableFetch` with a
non-empty approval id (a genuine, intentional network attempt) — and Vitest runs `it()`s in the file's
own top-to-bottom declaration order, so the new case's call landed BEFORE the older assertion ran,
failing it with "expected not to have been called, but was called 1 times" despite the older test's
own code being completely unchanged. Caught only because this pass re-ran the touched file ALONE
before calling anything settled (this file's own §"shared test Postgres" instruction, generalized to
in-process shared state too) — a full-module run would have reported it as a regression in a file
nobody edited that day. **Any new `it()` in an existing file that reuses a shared, stateful
module-level mock (a `vi.fn()` whose call count or history another case already asserts on) needs
either its OWN locally-scoped mock, or a `beforeEach`/`afterEach` reset that EVERY case in the file
already relies on** — reusing the shared one silently makes the new case's position in the file
load-bearing for a test it never mentions.

## Cross-session hazards

- **A `git status` snapshot goes STALE WITHIN MINUTES here — re-take it immediately before staging.**
  On 2026-08-23 I listed the dirty tree (108 other-session files), confirmed `docs/modules/CHANGELOG.md`
  and `MODULES.md` were both clean, did ~20 minutes of work, then staged them by explicit path — and
  swept another session's uncommitted `search-marketing 0.5.2` / SM-76 entry (~56 lines) into commit
  `8a9b74a`. Staging individual files is necessary but **not sufficient**: the file you verified as
  clean can acquire someone else's edits before you reach `git add`. Nothing was lost (their content
  is intact in `HEAD`, and `main` was never pushed), but the attribution is wrong in history.
  Also caught in the same `git add`: `platform-nest/src/rbac/iam-trap4-group-executive-split.test.ts`
  was **already in the index** from another session and came along even though I never named it —
  `git diff --cached --name-only` after staging, and comparing the count to what you intended, is the
  check that catches both. Do that every time.
- **Another session's uncommitted migration can turn `lint:migration-rls` red in YOUR tree.** On
  2026-08-23 `202608230230_iam15_remove_group_executive.sql` (untracked, IAM-15's in-flight work)
  flagged a `DELETE on "position_roles"` with no per-tenant GUC. It is NOT on `main`, so CI is not
  red — but the gate reads the whole `migrations/` directory, so a red local lint is not proof that
  *your* change is at fault. Check `git status` on the flagged file before debugging it.
- **Migration numbering is CLOSED at `0118`.** New migrations are `YYYYMMDDHHMM_snake_case.sql` (UTC) —
  `platform-nest/scripts/lint-migration-names.mjs` enforces it. Duplicate prefixes are *functionally*
  safe (the ledger keys on full filename); **never rename an applied migration.**
- **`GAIADA_TAG` moves under you.** A deploy landed mid-ceremony and moved the running tag; a stale
  `.env` would have rolled the API back as a side effect of a config change. Re-check immediately
  before any `up -d`.
- **The compose set on `gda-aicenter` is three files** (`vps` + `hostdata` + `observability`). Read it
  off the running container's own labels rather than guessing.
- **Worktrees can be cut before a commit made in the same turn.** Commit design docs a turn earlier,
  and restate binding constraints in the ticket body. **This bit SMM-31 directly**: the senior-be
  seat's worktree had no `docs/plans/smm-tracker.md` at all (it existed only in the shared checkout,
  uncommitted at worktree-cut time) — reconstructed from the shared checkout's content before adding
  this ticket's own row.
- **`docs/MAP.md` conflicts on almost every parallel merge** — regenerate, never hand-merge.
