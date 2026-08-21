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
| PD `direct` driver (SMM-38) | **4 (38a, 38b, 38c, 38d) + 38e partial** | 5 phases |
| P3 content ops | **5** (+1 partial) | 8 |
| P4 agents + assistant | 0 | 3 |
| Decision-gated | — | 3 (1 dead) |

Module: `social-media 0.5.10 · IN PROGRESS` — publish loop **DEV-VERIFIED against the mock driver**;
live network publishing **deferred to staging** (D-23); client-review stage **DEV-VERIFIED end to
end** — backend (SMM-31) + portal UI + composer/calendar reflection (SMM-32), a real client decision
via the portal driven in a real browser and observed landing correctly in the staff Composer in the
SAME running process; metrics (SMM-21) **DEV-VERIFIED** — `pullMetrics` nightly ingest + the
Analytics tab, driven in a real browser, `main.ts` registration **confirmed landed**; the SMM-33
capability inventory + SMM-24 docs closure found the entire client-review capability group has no
MCP tool and named it plainly rather than papering over it; SMM-38 phase 38c gave `direct` its first
real capability (LinkedIn OAuth + org-page publish + media + `pullComments`); phase 38d (this pass)
adds YouTube's resumable upload (which IS the publish call for that network in this driver — no
`schedulePost`), quota accounting against SMM-37's three real buckets (self-tracked, not a live
probe — Google exposes none), and `pullComments` via `youtube.force-ssl`, resolving the
`uploadMedia` network-routing collision 38c named by widening the port. Both networks remain
contract/unit-tested against a stub (no live LinkedIn/YouTube credential exists, D-23); phase 38e
(this pass) closes the three gaps 38c/38d named and left for it — a live dispatch path DOES now reach
`direct` for real for LinkedIn (proven with a real OAuth-token row, not merely asserted), a real
YouTube title/description channel, and a durable YouTube quota counter — while reporting YouTube's
own dispatch-path flip as an open architecture question rather than wiring around it. Module:
`social-media 0.5.10 · IN PROGRESS`.
| PD `direct` driver (SMM-38) | **1 (38a)** | 5 phases |
| P3 content ops | 2 (+2 partial) | 8 |
| P4 agents + assistant | 0 | 3 |
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
| 38b | **Token custody** — encrypted at rest on the tenant wall, refresh-ahead, revocation fails closed | ✅ **merged** |
| 38c | **LinkedIn** — OAuth, org-page publish, media, `pullComments` (48h retention) | 🟡 **partial** — real driver methods + real OAuth flow, contract/unit-tested against a stub; nothing wired into a live dispatch path yet (see evidence below) |
| 38d | **YouTube** — OAuth, resumable upload, 3-bucket quota, `pullComments` | 🟡 **partial, this pass (senior-integrator)** — real driver methods + real OAuth flow, quota accounting; contract/unit-tested against a stub; nothing wired into a live dispatch path yet (see evidence below) |
| 38e | Flip LinkedIn + YouTube to `direct`; Postiz retained for IG/FB/TikTok | 🟡 **partial (2026-08-21, senior-integrator)** — Gap 1 (live dispatch wiring) + Gap 2 (metadata) + Gap 3 (durable quota) all CLOSED and proven live; LinkedIn's flip is real, credential-gated only (D-23); YouTube's flip is reported BLOCKED on an open dispatch-state-machine question (upload-is-publish), not wired around — see evidence below |

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
4. **The OAuth state's DB-backed single-use gap** — named, not silently decided as unnecessary; a
   future pass wanting full parity with the Google flow's atomic consume would add a small state
   table.

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

**What the architect must decide — named, not guessed at:** the dispatch-state-machine
representation for a network whose publish terminates at `uploadMedia` rather than a separate
`schedulePost` step (YouTube, today; potentially a future network). Until decided,
`youtube:media_upload` must never be set to `direct` in `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` on any
deployment, credentialed or not — a config value nothing currently prevents an operator from setting,
which is itself worth the architect's attention (should `resolvePublisherForCapability` refuse an
override the dispatch flow cannot safely honour, rather than accepting any registered driver name?
Not decided here — this ticket's own file surface and mandate stop at reporting the question).

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
| SMM-22 | X metering live: stop-loss in dispatch **and** precondition, usage panel | ⬜ | widens SMM-09's budget stage |
| SMM-23 | Reports: snapshot + AI narrative → approve → render → Drive | ✅ | backend DEV-VERIFIED against live Postgres + Redis + a real sidecar round trip, evidence below |
| SMM-24 | Docs/registration, BFF rows, toolkit entry, MAP regen, AGPL source-offer footer | ✅ **docs closed** 2026-08-20 | toolkit entry **already complete** (`deptToolkits.ts`, all four routes); MODULES/CHANGELOG current; two stale doc claims corrected 2026-08-20; `docs/FRONTEND-BFF-CONTRACT.md` §19 gained the missing dispatch-endpoint row, the webhook-intake row, and the two SMM-21 metrics rows, each verified against the controller code read directly. **The AGPL source-offer itself is NOT built** — confirmed (no footer surface anywhere in the staff console; `DeptShellFrame.tsx`/`departments/[deptId]/layout.tsx` carry none, `PortalShell.tsx`'s is client-facing) and a placement recommended (see the gap entry below, updated) — remains a tracked gap for the owner/senior-uiux to action, not a build this ticket's docs scope covers |
| SMM-25 | Full-stack e2e + Playwright suite + DEMO_MODE fixtures | 🟡 partial | DEMO_MODE social fixture landed in SMM-14 |
| SMM-33 | Capability inventory + eval register | ✅ **docs closed** 2026-08-20 | golden-case table (SMM-14, proof of P1) stands; **the companion registry now exists**: `docs/modules/social-capability-inventory.md` — every capability across P0–P3-merged, endpoint · MCP tool · impact class · refusal vocabulary · `work_activity` row, built from the controllers/index.ts/approval-executables.ts directly. **18 MCP tools**, not 17 (this row's own prior estimate, corrected by counting `name:` occurrences in `index.ts`). Two structural gaps found and stated plainly, not filled with a plausible guess: the entire client-review capability group (request/read/withdraw/decide) has no MCP tool, and the post-status webhook callback writes no `work_activity` row with no stated reason (unlike the purge/metrics jobs, which name theirs) |

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
| **`metrics-job.ts` reads `process.env` directly rather than `config.ts`** — the seat was held out of `config.ts` to avoid a three-way collision, so `SOCIAL_METRICS_PULL_ENABLED`/`_INTERVAL_MS` are the only social knobs not visible where an operator greps for them. Harmless today, drift tomorrow | small cleanup |
| **AGPL §13 source-offer has nowhere to live — CONFIRMED again 2026-08-20 (SMM-33/24 docs pass), not rebuilt.** Postiz is AGPL-3.0 and §13 requires offering its modified source to users who interact with it over a network. Re-checked directly: `departments/[deptId]/layout.tsx` and `DeptShellFrame.tsx` carry no footer element at all; `PortalShell.tsx`'s `<footer className="cp-foot">` is the only footer in the codebase and it addresses the CLIENT portal, the wrong audience (§13's obligation is triggered by the STAFF console's requests reaching Postiz, not by a client viewing a published post on the open social network). **Recommendation, not built:** a one-line footer in `platform-ui/src/app/(app)/layout.tsx` — the shell wrapping every staff page, the direct staff-side analogue of `PortalShell.tsx`'s own footer — rather than scoping it to the social department alone, so it survives future routing changes without anyone having to remember which pages touch Postiz. Needs a deliberate placement decision from the owner + senior-uiux, not an invented component | owner + senior-uiux |
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
`.resolves.not.toThrow()`.

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
