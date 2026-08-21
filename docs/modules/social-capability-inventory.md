# Social-media (SMM) — capability inventory + eval register

**SMM-33.** The agentic exit bar's item 6 requires one row per capability naming its endpoint, MCP
tool, D14 impact class, typed refusal vocabulary, and `work_activity` row. SMM-14 already produced
the **golden-case table** (`docs/modules/MODULES.md`, social-media 0.5.2 entry) — a proof, one row
per P1 capability, each showing a REAL refusal actually driven. **This is the companion, not a
duplicate**: a registry of every capability the module currently exposes (P0 through the merged half
of P3), built by reading the controllers and the module contract directly, not the design docs. Gaps
are stated plainly — a blank filled with a plausible-looking value would defeat the reason this
document exists.

Built against `platform-nest` at commit `94f5b39` (this worktree's HEAD after fast-forwarding onto
`main` to pick up SMM-21, which had merged to `main` but not yet reached this worktree's starting
point — see the note at the bottom).

Sources read directly, no other doc trusted over them:
- `src/modules/social/social.controller.ts` — the `@Controller("api/:tenantId/modules/social")` surface.
- `src/core/social-client-review-portal.controller.ts` — the portal decide surface.
- `src/modules/social/index.ts` — `socialModule.mcpTools` (18 tools, not the 17 the tracker's row
  estimated before this pass counted them).
- `src/core/approval-executables.ts` — the D14 registry: `social.publishPost` executable,
  `social.publishPostMetered` barred.
- `src/modules/social/publish-precondition.ts` — `PUBLISH_REFUSAL` (16 tokens),
  `SOCIAL_PUBLISH_TOOL_CLASSIFICATION`.
- `src/modules/social/dispatch.ts` — `DISPATCH_REFUSAL` (4 tokens).
- `src/modules/social/client-review.ts` — `CLIENT_REVIEW_REFUSAL` (5 tokens).
- `src/modules/social/publisher/types.ts` — `PublisherRefusalCode` (11 tokens total; SMM-07 added
  three of them: `platform_app_not_registered`, `client_connect_requires_signoff`,
  `connect_redirect_not_configured`).
- `src/modules/social/publisher/direct.ts` — `capability_unsupported`, the 38a skeleton's refusal.
- `src/core/http.ts#writeActivity` and every call site of it under `src/modules/social/` and
  `src/core/social-client-review-portal.controller.ts` (18 call sites — grepped, not assumed).

**A verification note, because this module has a recent history of a seat trusting prose over code:**
`src/events/work-activity-consumer.ts`'s `WORK_ACTIVITY_STREAMS` is `["pm_task", "pm_project",
"pm_doc", "meeting_recording", "pipeline_run"]` — **no social stream**. That is the *async,
outbox-derived* `work_activity` path other modules use; it does **not** mean social capabilities
skip `work_activity` altogether. Social writes it through the *synchronous* path instead —
`writeActivity()` called directly from the controller/service after each state change, the same
helper `pm`/`meetings`/`portal`/`webdev-change-requests` also import. Both paths land in the same
`work_activity` table; social simply never needed the outbox hop because every social write already
happens inside an authenticated HTTP request with a principal in hand. Stated here because grepping
only the consumer file, the way a stale-comment defect got introduced elsewhere in this module,
would have produced a false "social emits no work_activity" finding.

---

## Engagements — Cerbos kind `social_engagement`

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| List engagements | `GET engagements` | `social.listEngagements` | read (untiered — no `write`/`impact` on this tool def) | ad hoc (403 on denial; no typed vocabulary) | none (read) |
| Create engagement | `POST engagements` | `social.createEngagement` | write, **low** | ad hoc: `missing_field`, `invalid_id` | `created` / `social_engagement` |
| Get engagement | `GET engagements/:id` | **none** — no single-get tool exists; only the list tool does | read, unclassified | 404 | none (read) |
| Update engagement | `PATCH engagements/:id` | **none** | write, unclassified (no MCP tool ⇒ no D14 impact pair declared) | ad hoc: `invalid_status`, `no_fields`, 404 | `updated` / `social_engagement` |
| Delete engagement | `DELETE engagements/:id` | **none** | write, unclassified | 404 | `deleted` / `social_engagement` |
| Get engagement tool-scope + budget | `GET engagements/:id/scope` | `social.getEngagementScope` | read, unclassified | ad hoc / 404 | none (read) |
| Set engagement tool-scope + budget | `PATCH engagements/:id/scope` | `social.setEngagementScope` | write, **medium** | ad hoc: `invalid_scope`, `invalid_scope_value`, `invalid_budget` | `updated` / `social_engagement` |

**Gap named plainly:** four of these seven capabilities (get/update/delete engagement; the two
brand-profile routes below) have **no MCP tool at all** — an automation/agent principal cannot read
a single engagement, edit one, delete one, or touch a brand profile through the tool surface today,
only a human console session can. `getEngagementScope`/`setEngagementScope`/`listEngagements` are
covered; plain CRUD is not. Not necessarily wrong (some of this may be intentionally console-only),
but nowhere is that a stated decision — it reads as an omission, not a design choice, and item 6
exists to surface exactly that difference.

## Brand profiles — Cerbos kind `social_engagement`

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Get brand profile | `GET brand-profiles/:clientId` | **none** | read, unclassified | 404 | none (read) |
| Upsert brand profile | `PATCH brand-profiles/:clientId` | **none** | write, unclassified | ad hoc: `no_fields` | `updated` / `social_brand_profile` |
| Ingest brand corpus (SMM-19) | `POST engagements/:id/brand-corpus/ingest` | `social.ingestBrandCorpus` | write, **low** | ad hoc: `missing_field`, `too_many_chunks`, `ai_drafting_disabled` | `updated` / `social_brand_profile` |

## Campaigns + KPI targets — Cerbos kind `social_engagement`

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| List campaigns | `GET campaigns` | **none** | read, unclassified | none named | none (read) |
| Create campaign | `POST campaigns` | **none** | write, unclassified | ad hoc: `missing_field`, `invalid_id` | `created` / `social_campaign` |
| List KPI targets | `GET kpi-targets` | **none** | read, unclassified | none named | none (read) |
| Create KPI target | `POST kpi-targets` | **none** | write, unclassified | ad hoc: `missing_field`, `invalid_direction`, `invalid_id` | `created` / `social_kpi_target` |

**Gap named plainly:** neither campaigns nor KPI targets have an MCP tool — an agent drafting a
campaign plan or setting a KPI target has no tool to call; both are console/human-only today.

## Posts + variants — Cerbos kind `social_post`

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| List posts | `GET posts` | `social.listPosts` | read, unclassified | none named | none (read) |
| Create post | `POST posts` | `social.createPost` | write, **low** | ad hoc: `invalid_source` | `created` / `social_post` |
| Get post | `GET posts/:id` | **none** | read, unclassified | 404 | none (read) |
| Update post | `PATCH posts/:id` | **none** | write, unclassified | ad hoc | `updated` / `social_post` |
| Delete post | `DELETE posts/:id` | **none** | write, unclassified | `post_has_live_variants` | `deleted` / `social_post` |
| Add post variant | `POST posts/:id/variants` | `social.addPostVariant` | write, **low** | validation-matrix tokens (23, `docs/FRONTEND-BFF-CONTRACT.md` §19) | `created` / `social_post_variant` |
| Update variant | `PATCH variants/:id` | **none** — `validateVariant` is read-only, not this | write, unclassified | `variant_native_import_immutable`, `variant_not_editable` | `updated` / `social_post_variant` |
| Delete variant | `DELETE variants/:id` | **none** | write, unclassified | `variant_is_live` | `deleted` / `social_post_variant` |
| Validate variant (dry run) | `GET variants/:id/validation` | `social.validateVariant` | read, unclassified | the 23-token validation matrix (warnings vs. errors) | none (read) |
| Check publish preconditions (dry run) | `GET variants/:id/publish-preconditions` | `social.checkPublishPreconditions` | read, unclassified | `PUBLISH_REFUSAL` (16) composed behind `CLIENT_REVIEW_REFUSAL` (5) when the engagement requires client sign-off | none (read; the dry run consumes nothing) |
| Import a hand-published post | `POST posts/import-native` | `social.importNativePost` | write, **low** | ad hoc | `created` / `social_post` (`nativeImport:true`) |
| AI-draft a caption (SMM-19) | `POST posts/:id/variants/:id/draft-caption` | `social.draftPostVariant` | write, **low** | `ai_drafting_disabled`, `image_generation_unavailable` | `updated` / `social_post_variant` |
| AI-draft post ideas (SMM-19) | `POST posts/draft-ideas` | `social.draftPostIdeas` | write, **low** | same two tokens as above | `created` / `social_post` (`source:'ai'`) |

## Client review (SMM-31/32, D-16) — Cerbos kind `social_client_review` (staff) / `portal` action `approve_post` (client)

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Request client review | `POST variants/:id/client-review` | **`social.requestClientReview`** (CLOSED 2026-08-21) | write, **medium** — the first moment content crosses the client trust boundary | 404 (this endpoint's own; `CLIENT_REVIEW_REFUSAL` is what the *gate* checks, not what this endpoint returns) | `requested` / `social_post_client_review` |
| Read client review state | `GET variants/:id/client-review` | **`social.getClientReview`** (CLOSED 2026-08-21) | read, unclassified | none — `{status:'not_requested'}` is data, not an error | none (read) |
| Withdraw client review | `POST variants/:id/client-review/withdraw` | **`social.withdrawClientReview`** (CLOSED 2026-08-21) | write, **low** — corrective, never notifies the client | `client_review_not_pending`, 404 | `withdrawn` / `social_post_client_review` |
| Client decides (portal) | `POST :tenantId/portal/social-reviews/:id/decide` | **none — no portal capability is ever an MCP tool in this program** | write, unclassified | ownership resolves as "not found" rather than "not yours" (0075 rule 1); a second decide on an already-resolved row is a conflict, not a crash | `approved`/`changes_requested` / `social_post_client_review` |

**Gap CLOSED 2026-08-21 (senior-be).** The largest parity hole this pass found is now covered: three
new tools on `socialModule.mcpTools` (`modules/social/index.ts`) front the staff-side trio, each
running the SAME `authorize()` call its endpoint already runs — `social.client_review.
{read,request,withdraw}` (real, grantable Cerbos permissions since SMM-31/32) are now reachable by
an agent, not only a human console session. An agent operating this module can now ask a client for
sign-off, check whether one is pending, and withdraw a stale ask, closing the "does it work
identically under a human, n8n, and an agent" gap the agentic-native plan's criterion 1 names.
`request` is impact `'medium'` (suspends an automation/agent principal into WS4 — it is the first
exposure of content to an external party, the same "outward-facing" ground `deliverReport`/
`provisionPublisherOrg` already use); `withdraw` is impact `'low'` (a write, never a read, but
purely corrective and never client-notified — the same "blast radius is a stale row" ground
`syncConnectorRegistry` already uses); `read` carries no write/impact pair, matching every other
plain read tool. **The portal decide stays undeclared, confirmed rather than merely repeated**: it
is a `portal.*` action (`approve_post`), never `social.*`, and no portal capability is ever an MCP
tool in this program — the client's decision is a human act on the trust boundary, made in an
authenticated browser session, never something any agent (staff-side or client-side) is the caller
of. Regression-pinned in `social.test.ts`.

**A real, adjacent gap found while closing this one, named but NOT fixed this pass (out of file
surface):** `social.client_review.withdrawn`'s event has no registered handler in
`event-handlers.ts`'s routing table, unlike `.requested`/`.decided` — which is WHY `withdraw` never
notifies the client and part of why it is classified 'low' rather than 'medium'. Left for a future
pass; the gap is cosmetic today (nothing currently depends on a withdrawal notification existing).

## Publish / dispatch (SMM-09/10) — the D14 spine

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Execute a publish | `POST variants/:id/publish` | `SOCIAL_PUBLISH_TOOL` (`social.publishPost`) | write, **high** — `SOCIAL_PUBLISH_TOOL_CLASSIFICATION`, the pinned D14 registry entry in `approval-executables.ts` | `PUBLISH_REFUSAL` (16) → `CLIENT_REVIEW_REFUSAL` (5, checked first when required) → `DISPATCH_REFUSAL` (4, once past preconditions: `approval_not_resolvable`, `dispatch_stamp_race_lost`, `dispatch_error`, `media_upload_failed`) | `dispatched` / `failed` / `refused` — `social_post_variant` (`dispatch.ts`) |
| Metered publish (the twin) | **no endpoint — never dispatched** | `social.publishPostMetered` **registered BARRED**, never declared as an MCP tool (`registerBarredExecutable`, reason `metered_tool_barred`) | n/a — barred, D-14's money split | `metered_network_requires_metered_tool` is `publishPost`'s own precondition refusing a metered-network variant before it ever reaches this twin | none — it never executes |

## Webhook intake (SMM-10) — machine-to-machine, no principal

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Post-status reconcile callback | `POST webhooks/post-status` | **none — not agent-facing by design; gated by a service-token + `x-social-webhook-secret`, not Cerbos** | write, unclassified | HTTP-level (401/403 on a bad/missing secret); the underlying `reconcileOneProviderPost` (`post-status-sync-job.ts`) returns a boolean, no typed refusal vocabulary | **`published`/`failed` on `social_post_variant`, `actor_id NULL`** (CLOSED 2026-08-21) |

**Gap CLOSED 2026-08-21 (senior-be), at the shared root rather than the named function alone.**
`applyPostStatuses` (`post-status-sync-job.ts`) is the ONE function both `reconcileOneProviderPost`
(this webhook) and `reconcileTenantPostStatus` (the safety poll) call to apply the network's own
authoritative `'published'`/`'failed'` status — fixing it there closes the gap for BOTH unattended
paths, not only the one this row names. It now calls `writeActivity(tenantId, null, verb,
"social_post_variant", variantId, metadata)` for each transition, fired AFTER the update transaction
commits (matching `dispatch.ts`/`pm.controller.ts`'s own non-nested sequencing for this helper).
This was NOT the "no user attribution to attach a row to" bucket the golden-case table puts the
retention purge and metrics pull in — those two never touch a single named entity's own audit trail
the way a publish/dispatch/reconcile lifecycle does; this row is closer kin to `dispatch.ts`'s own
`dispatched`/`failed`/`refused` rows (which DO attribute to a human, because dispatch is always
human-triggered via the D14 executor) than to a bucket sweep. `actor_id` is `null`, honestly: neither
caller ever has a principal (`postStatusWebhook` doesn't even take a `@Req()`) — matching the
`activities` table's own column comment ("NULL = system/service") and the SAME convention
`pm.controller.ts`'s `auto_promoted` rows already use, never a guess at "whoever last touched the
row." Regression-pinned in `post-status-sync-job.test.ts` (T1/T2/T3/T5), driven RED first.

## Accounts, publisher orgs, connect (SMM-05/07) — Cerbos kind `social_account`

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| List accounts | `GET accounts` | `social.listAccounts` | read, unclassified | none named | none (read) |
| Provision publisher org | `POST publisher-orgs` | `social.provisionPublisherOrg` | write, **medium** | `PublisherRefusalCode`: `org_conflict`; ad hoc `missing_publisher_org_ref`, `unknown_driver` | `created` / `social_publisher_org` |
| Sync connector registry | `POST publisher-orgs/:clientId/sync` | `social.syncConnectorRegistry` | write, **low** | `PublisherRefusalCode`: `publisher_unreachable`, `publisher_http_error`, `org_not_provisioned` | `synced` / `social_publisher_org` |
| Connect readiness (dry run) | `GET publisher-orgs/:clientId/connect/:network` | **none** | read, unclassified | SMM-07's three: `platform_app_not_registered`, `client_connect_requires_signoff`, `connect_redirect_not_configured` | none (read) |
| Connect account | `POST publisher-orgs/:clientId/connect` | **none** | write, unclassified | same three `PublisherRefusalCode`s + ad hoc `invalid_client`, `unknown_network`, `missing_handle` | `initiated` / `resumed` — `social_account` (`provisioning.ts`, not the controller — the call is one layer down) |
| Publisher status | `GET publisher/status` | `social.getPublisherStatus` | read, unclassified | `capability_unsupported` (38a's `direct` skeleton) surfaces here for any capability check that resolves to `direct` | none (read) |

**Gap named plainly:** the connect ceremony (dry-run readiness + the actual connect POST) has no
MCP tool — by design, per the golden-case table's own note ("an OAuth ceremony needs a human in a
browser"), but that design reasoning is stated for the connect POST, not repeated here for the
readiness GET, which is a pure read an agent could in principle consult. Left as-is; named so the
absence reads as considered, not missed.

## Driver per capability (SMM-38, the `direct` driver) — which engine actually serves each capability

§PD's own exit criterion for phase 38e: *"Capability inventory records which driver serves each
capability."* The switch (`registry.ts#resolvePublisherForCapability`) is config-driven and keyed on
`(network, capability)`, most-specific-wins — see that file's own header. The table below records, for
each (network, capability) pair this driver wave actually built something for, which engine COULD
serve it and what stands between "could" and "does" today.

| Network | Capability | Served by (default, no config) | Served by (if flipped) | What's missing for the flip to be more than principle |
|---|---|---|---|---|
| LinkedIn | `schedule` (publish) | Postiz (AGPL zone) | `direct` — REAL org-page publish, contract-tested (38c) | A `social_platform_apps` row + non-empty `SOCIAL_LINKEDIN_CLIENT_ID`/`_SECRET` (D-23, deferred to staging) — **principle-only for want of credentials**, nothing else. The dispatch-side wiring itself is REAL: `dispatch.test.ts`'s (D1)–(D4) drive a genuine `resolveActiveAccessToken` call and a genuine second driver receiving the resolved bearer token, end to end, against a real Postgres row |
| LinkedIn | `media_upload` | Postiz | `direct` — REAL 3-step asset upload, contract-tested (38c) | Same as above — credential-gated only |
| LinkedIn | `inbox_read` (`pullComments`) | n/a — Postiz has NO inbox surface for any network (spike §8b) | `direct` — REAL per-post comment read, contract-tested (38c) | Same as above; ALSO gated on SMM-15 (P2 inbox sync) existing to ever call it — no caller exists yet regardless of credentials |
| YouTube | `media_upload` (= publish, for this network) | Postiz | `direct` — REAL resumable upload, contract-tested (38d), now with real title/description (38e, Gap 2) | **UPDATED, SMM-38e closing pass (2026-08-21): the dispatch-flow gap is CLOSED.** `SocialPublisher.isUploadTerminalFor` (types.ts) lets `direct` declare that its YouTube upload IS the publish; `dispatch.ts#dispatchApprovedPublish` consults it and never calls `schedulePost` afterward, stamping the upload's own returned id as `provider_post_id` through the SAME single-transaction stamp every other network uses (proven live: `dispatch.test.ts`'s (E1)–(E3)). `youtube:media_upload=direct` is therefore now **principle-safe** — only the SAME credential gap that already gates LinkedIn's own flip (D-23) stands between it and a live call. The recommended override below now includes it |
| YouTube | `quota_probe` | n/a — Postiz never advertised this for YouTube | `direct` — REAL accounting (38d) against a NOW-DURABLE store (38e, Gap 3: `social_youtube_quota_usage`, global, no RLS, D-4's own reasoning) | Credential-gated only, now that the row above's dispatch-flow gap is closed |
| YouTube | `inbox_read` (`pullComments`) | n/a — Postiz has no inbox surface | `direct` — REAL comment read via `youtube.force-ssl` (38d) | Credential-gated + SMM-15, same as LinkedIn's row |
| YouTube | `schedule` | Postiz | **not built, and never will be for this driver** — `direct` deliberately does not advertise `schedule` for YouTube (`coversNetworkCapability("youtube","schedule")` is `false`; a `videos.insert` call IS the post, there is no distinct "reference an already-uploaded asset" step to implement) | An override naming `youtube:schedule=direct` in isolation refuses EAGERLY at the resolver (`capability_unsupported`, `registry.ts`'s new override-safety check, SMM-38e closing pass) rather than reaching the network — proven in `dispatch.test.ts`'s (E3) |
| Instagram / Facebook | everything | Postiz (AGPL zone) | **not built** — `direct` has zero IG/FB capability | Meta Business Verification (staging, D-23) is the serial prerequisite before ANY IG/FB work on `direct` would even be worth starting (§PD: "IG/FB stay on Postiz") |
| TikTok | everything | Postiz (AGPL zone, D-21 fork exception) | **not built** — `direct` has zero TikTok capability | TikTok's own audit (staging, D-23); §PD: "TikTok stays behind its own audit" |

**SMM-38e closing pass (2026-08-21) — the two gaps this section's own prior text named, closed.**
38e's own evidence reported, rather than decided, that flipping `youtube:media_upload` to `direct`
would upload a real video and then hit a doomed second `schedulePost` step, and that
`resolvePublisherForCapability` accepted any registered driver name for any (network, capability) pair
without asking whether the resolved driver could actually honour it. Both are now closed, by two
independent, additive port members (`types.ts`), never a special case buried in `dispatch.ts`:

- **`SocialPublisher.isUploadTerminalFor(network)`** — a driver declares, per network, that its
  `uploadMedia` IS the publish (no distinct schedule step exists to call). `direct.ts` declares this
  `true` for YouTube only. `dispatch.ts` consults it and, when true, stamps the upload's own returned
  id as `provider_post_id` and never calls `schedulePost` for that dispatch.
- **`SocialPublisher.coversNetworkCapability(network, capability)`** — a driver declares, per
  (network, capability) pair, whether it actually serves it — the SAME "driver declares what it can
  serve" precedent `DIRECT_CAPABILITIES`/`capabilities.ts`'s three-reasons model already set, promoted
  to cover the ROUTING question, not just the account-facing one. `registry.ts#resolvePublisherForCapability`
  consults it and refuses EAGERLY, with a typed `capability_unsupported`, any override naming a pair
  the resolved driver does not cover — before any network call, not after one. Backed by ONE map on
  `direct.ts` (`NETWORK_CAPABILITIES`) that both this check and the driver's own per-method gates read
  from, so a future network/capability pair needs exactly one new entry, never a second list to
  remember.

Both are OPTIONAL port members — absent on a driver (Postiz, the mock) means "no per-network
restriction" / "never terminal", so every existing deployment and every existing test is unaffected;
proven by `publisher.test.ts`'s full 64/64 (was 63/63) and every OTHER social suite passing verbatim.
The result: `youtube:media_upload=direct` moves from "reported unsafe, deliberately excluded" to
"principle-safe, credential-gated only", and `youtube:schedule=direct` (a config value nothing
previously prevented an operator from setting) now refuses at the earliest possible moment instead of
silently resolving to a driver that would fail deep inside `schedulePost`.

**The flip itself (38e, and this closing pass) does NOT change the shipped default.**
`config.social.publisher.capabilityDrivers` stays the empty map every prior phase shipped — every
deployment with no `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` set behaves EXACTLY as before this phase, for
every network, including LinkedIn and YouTube (proven, not merely claimed: every existing
`publisher.test.ts` case that predates this closing pass still passes byte-for-byte). The recommended
override for a deployment that HAS cleared the relevant credential gate (D-23) is now
`linkedin:schedule=direct,linkedin:media_upload=direct,linkedin:inbox_read=direct,youtube:media_upload=direct,youtube:inbox_read=direct,youtube:quota_probe=direct`
— YouTube's three covered capabilities now INCLUDED, `youtube:schedule` still correctly ABSENT (there
is nothing for it to name; `direct` never covers it, and setting it would now refuse eagerly rather
than silently doing nothing useful). Setting an override is an explicit, staging-time operator action;
nothing in this phase makes that decision on a deployment's behalf.

**Why "principle-only" was the honest word, twice over, for two different reasons in 38e's own wave —
and why it is now honest just ONCE, for YouTube's `media_upload`/`inbox_read`/`quota_probe`:**
38e reported (1) every platform app credential in the estate is empty (D-23, deferred to staging) —
true for LinkedIn AND YouTube equally; (2) YouTube ALSO carried a second, independent gap that had
nothing to do with credentials — the dispatch state machine did not yet know how to represent a
network whose publish terminates at `uploadMedia`. This closing pass resolves (2) for good, leaving
only (1) — the SAME credential gap every other flip in this table already carries, nothing new.

## Metrics (SMM-21) — read-only, `social_account::read`

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Per-account daily metrics | `GET metrics/daily` | **none** | read, unclassified | ad hoc: `missing_field` (no `engagementId`) | none (read) |
| Per-post metrics snapshot | `GET metrics/posts` | **none** | read, unclassified | ad hoc: `missing_field` | none (read) |

**Gap already named by SMM-21 itself** (`docs/modules/MODULES.md`'s 0.5.6 entry, "anything the spec
did not answer"): no MCP tool for either read route — the ticket brief named `pullMetrics` + the
tables + the Analytics tab, not an agent-facing tool. Restated here rather than silently repeated as
new, since item 6 is exactly the place a pre-named gap should also land.

## Nightly / scheduled jobs — no HTTP surface, no principal

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Inbox retention purge (SMM-36) | — (scheduled sweep) | — | n/a | per-tenant failure isolated, never swallows every tenant | none — a purge, not a user action (unchanged from the golden-case table) |
| Metrics nightly pull (SMM-21) | — (scheduled sweep) | — | n/a | per-tenant/per-account/org failures logged and swallowed independently | none — system-originated, no principal to attribute to |

---

## Summary — what item 6 actually shows

- **21 MCP tools declared** (`modules/social/index.ts`), up from 18 as of this pass (2026-08-21,
  senior-be) — the three new client-review tools (Gap 1, below). The tracker's prior estimate of
  "17" undercounted by one before that; both corrections recorded in `docs/plans/smm-tracker.md`.
- **`social.publishPost` IS declared and IS the D14-registered executable** (`write:true,
  impact:'high'`); `social.publishPostMetered` is barred and correctly never declared. (The prior
  seat's contrary finding was traced to grepping the literal string instead of the
  `SOCIAL_PUBLISH_TOOL` constant — see `docs/plans/smm-tracker.md`'s defect-class §4b.)
- **The two structural gaps this pass originally found are now BOTH CLOSED (2026-08-21, senior-be):**
  1. ~~The entire client-review capability group (request/read/withdraw + the portal decide) has no
     MCP tool.~~ **CLOSED** — `social.requestClientReview`/`social.getClientReview`/
     `social.withdrawClientReview` now cover the staff trio; the portal decide is confirmed to stay
     undeclared, by design, not by omission.
  2. ~~The post-status webhook callback (`reconcileOneProviderPost`) writes no `work_activity`
     row.~~ **CLOSED** — fixed at the shared `applyPostStatuses` root, covering the safety-poll path
     too, with an honestly-attributed (`actor_id NULL`) row.
- **A THIRD gap, never structural but real, remains open and is intentionally NOT declared an MCP
  tool:** every plain single-resource read/update/delete (engagement, post, variant, brand profile,
  campaign, KPI target) has no MCP tool — only list/create/scope-style capabilities got one. This
  may be intentional (a smaller declared surface is safer), but it has never been stated as a
  decision anywhere this or the prior pass found, and closing it was outside this pass's mandate
  (scoped to the two agentic-exit-bar gaps above).
- **`work_activity` coverage was broad but not total; the one gap this pass found and named is now
  closed.** The post-status webhook callback (`reconcileOneProviderPost`) wrote no `work_activity`
  row; `post-status-sync-job.ts` now carries a new `writeActivity()` call site inside the shared
  `applyPostStatuses`, covering both that webhook path and its safety-poll sibling
  (`reconcileTenantPostStatus`). This pass did not re-audit this file's earlier "18 call sites"
  figure for the rest of the module — that count was produced by a prior pass and re-verifying it
  was outside this pass's two named gaps.
- **Five named refusal vocabularies, all verified against the source file that declares them:**
  `PUBLISH_REFUSAL` (16), `DISPATCH_REFUSAL` (4), `CLIENT_REVIEW_REFUSAL` (5), SMM-07's three
  `PublisherRefusalCode` additions (of 11 total in that union type), and `direct.ts`'s single
  `capability_unsupported` token (SMM-38a). Every count above was obtained by reading the exported
  `const`/`type` itself, not by trusting a prior document's tally.

## A cross-session note on how this document was produced

This worktree's `HEAD` was cut before `main` had merged SMM-21 (`9a5a8f5`) — a clean fast-forward
was available (`git merge-base --is-ancestor HEAD main` was true, no divergent commits), so this
session fast-forwarded onto `main` (`94f5b39`) before reading any code, rather than building this
inventory against a stale tree that was missing `metrics-job.ts`, the two `GET metrics/*` routes,
and the Analytics tab entirely. Recorded per this program's own "worktrees can be cut before a
commit made in the same turn" hazard (`docs/plans/smm-tracker.md`, Cross-session hazards).
