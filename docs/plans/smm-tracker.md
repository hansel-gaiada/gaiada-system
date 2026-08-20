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
| P2 inbox + client approval | **2** | 6 |
| PD `direct` driver (SMM-38) | **1 (38a)** | 5 phases |
| P3 content ops | 1 (+2 partial) | 8 |
| P4 agents + assistant | 0 | 3 |
| Decision-gated | — | 3 (1 dead) |

Module: `social-media 0.5.5 · IN PROGRESS` — publish loop **DEV-VERIFIED against the mock driver**;
live network publishing **deferred to staging** (D-23); client-review stage **DEV-VERIFIED end to
end** — backend (SMM-31) + portal UI + composer/calendar reflection (SMM-32), a real client decision
via the portal driven in a real browser and observed landing correctly in the staff Composer in the
SAME running process.

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
| SMM-15 | Inbox sync (`pullInbox`, idempotent upsert) | ⬜ | **SMM-38** — Postiz has ZERO inbound surface (OQ-4) |
| SMM-16 | AI triage: sentiment/category/urgency, spike detection, SLA | ⬜ | SMM-15 |
| SMM-17 | Reply flow: drafts → WS4 → send (own registry entry) | ⬜ | SMM-15; should set `neverAutoRetry` |
| SMM-18 | Inbox tab UI: triage queue, thread view, SLA timers | ⬜ | SMM-15/16/17 |

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

## PD — the `direct` driver (D-20) ⬜

Second `SocialPublisher` implementation alongside Postiz, switched per capability. The only free path
that removes the AGPL zone, both fork exceptions and the inbox gap together.

| Phase | Scope | State |
|---|---|---|
| 38a | Driver skeleton + per-capability switch (defaults to `postiz`) + shared contract suite | ✅ **merged** |
| 38b | **Token custody** — encrypted at rest on the tenant wall, refresh-ahead, revocation fails closed | ⬜ |
| 38c | **LinkedIn** — OAuth, org-page publish, media, `pullComments` (48h retention) | ⬜ depends on SMM-36 ✅ |
| 38d | **YouTube** — OAuth, resumable upload, 3-bucket quota, `pullComments` | ⬜ |
| 38e | Flip LinkedIn + YouTube to `direct`; Postiz retained for IG/FB/TikTok | ⬜ |

⚠ 38b reverses D-5 (client tokens deliberately live *inside* Postiz so we never hold them). That is a
security decision the owner accepted with D-20, not a convenience.

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
| SMM-21 | Metrics → `social_metrics_daily`, nightly flow, Analytics tab | ⬜ | |
| SMM-22 | X metering live: stop-loss in dispatch **and** precondition, usage panel | ⬜ | widens SMM-09's budget stage |
| SMM-23 | Reports: snapshot + AI narrative → approve → render → Drive | ⬜ | |
| SMM-24 | Docs/registration, BFF rows, toolkit entry, MAP regen, AGPL source-offer footer | 🟡 partial | toolkit entry **already complete** (`deptToolkits.ts`, all four routes); MODULES/CHANGELOG current; two stale doc claims corrected 2026-08-20. **Outstanding: the AGPL source-offer — see the gap below** |
| SMM-25 | Full-stack e2e + Playwright suite + DEMO_MODE fixtures | 🟡 partial | DEMO_MODE social fixture landed in SMM-14 |
| SMM-33 | Capability inventory + eval register | 🟡 partial | golden-case table landed in SMM-14. **Outstanding: the per-capability inventory row set** (endpoint · tool · impact class · refusal · `work_activity`) — 17 MCP tools enumerated, table not yet written |

## P4 — agents + assistant ⬜

| # | Ticket | State |
|---|---|---|
| SMM-26 | MCP agent surface for automation principals (OBO, D14); agents draft, never publish | ⬜ |
| SMM-27 | Best-time-to-post: classical stats + suggestion chip | ⬜ |
| SMM-35 | Assistant integration via ASST-23 propose → confirm → approve | ⬜ |

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
| **AGPL §13 source-offer has nowhere to live.** Postiz is AGPL-3.0 and §13 requires offering its modified source to users who interact with it over a network. The **staff console has no footer surface at all** (`departments/[deptId]/layout.tsx`, `DeptShellFrame.tsx`); the only footer is in `PortalShell.tsx`, which is client-facing and the wrong audience. Needs a deliberate placement decision, not an invented component | owner + senior-uiux |
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
`social-client-review-portal.controller.test.ts`'s header note).

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

## Cross-session hazards

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
