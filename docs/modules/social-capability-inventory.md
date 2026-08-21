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
| Request client review | `POST variants/:id/client-review` | **none** | write, unclassified | 404 (this endpoint's own; `CLIENT_REVIEW_REFUSAL` is what the *gate* checks, not what this endpoint returns) | `requested` / `social_post_client_review` |
| Read client review state | `GET variants/:id/client-review` | **none** | read, unclassified | none — `{status:'not_requested'}` is data, not an error | none (read) |
| Withdraw client review | `POST variants/:id/client-review/withdraw` | **none** | write, unclassified | `client_review_not_pending`, 404 | `withdrawn` / `social_post_client_review` |
| Client decides (portal) | `POST :tenantId/portal/social-reviews/:id/decide` | **none — no portal capability is ever an MCP tool in this program** | write, unclassified | ownership resolves as "not found" rather than "not yours" (0075 rule 1); a second decide on an already-resolved row is a conflict, not a crash | `approved`/`changes_requested` / `social_post_client_review` |

**Gap named plainly, and it is the single largest one this pass found:** every client-review
capability — request, read, withdraw, and the gate's own composed `CLIENT_REVIEW_REFUSAL` vocabulary
it produces on the dry-run/dispatch paths — has **zero MCP tool coverage**. `social.client_review.
{read,request,withdraw}` are real, grantable Cerbos permissions (SMM-31/32), but nothing in
`modules/social/index.ts` declares a tool for any of them. An agent operating this module can draft
a post, validate it, and dry-run its publish preconditions, but **cannot ask a client for sign-off,
check whether one is pending, or withdraw a stale ask** — it can only reach the read half indirectly
through `checkPublishPreconditions`'s composed `stage:"client_review"` answer, never act on it. This
is exactly the "does it work identically under a human, n8n, and an agent" bar the agentic-native
plan sets, and today it plainly does not for this whole capability group.

## Publish / dispatch (SMM-09/10) — the D14 spine

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Execute a publish | `POST variants/:id/publish` | `SOCIAL_PUBLISH_TOOL` (`social.publishPost`) | write, **high** — `SOCIAL_PUBLISH_TOOL_CLASSIFICATION`, the pinned D14 registry entry in `approval-executables.ts` | `PUBLISH_REFUSAL` (16) → `CLIENT_REVIEW_REFUSAL` (5, checked first when required) → `DISPATCH_REFUSAL` (4, once past preconditions: `approval_not_resolvable`, `dispatch_stamp_race_lost`, `dispatch_error`, `media_upload_failed`) | `dispatched` / `failed` / `refused` — `social_post_variant` (`dispatch.ts`) |
| Metered publish (the twin) | **no endpoint — never dispatched** | `social.publishPostMetered` **registered BARRED**, never declared as an MCP tool (`registerBarredExecutable`, reason `metered_tool_barred`) | n/a — barred, D-14's money split | `metered_network_requires_metered_tool` is `publishPost`'s own precondition refusing a metered-network variant before it ever reaches this twin | none — it never executes |

## Webhook intake (SMM-10) — machine-to-machine, no principal

| Capability | Endpoint | MCP tool | Impact class | Refusal | `work_activity` |
|---|---|---|---|---|---|
| Post-status reconcile callback | `POST webhooks/post-status` | **none — not agent-facing by design; gated by a service-token + `x-social-webhook-secret`, not Cerbos** | write, unclassified | HTTP-level (401/403 on a bad/missing secret); the underlying `reconcileOneProviderPost` (`post-status-sync-job.ts`) returns a boolean, no typed refusal vocabulary | **none** — `reconcileOneProviderPost` has no `writeActivity` call anywhere in it (grepped, confirmed absent) |

**Gap named plainly:** this endpoint performs a real state change (a post's status/`provider_post_id`
reconciled against the live network) with no `work_activity` row at all. It may belong in the same
"no user attribution to attach a row to" bucket the golden-case table already puts the retention
purge and metrics pull in (SMM-14/this pass) — it is machine-originated, not human-originated — but
that reasoning has never been written down for this specific endpoint, so it is named here rather
than assumed.

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
| YouTube | `media_upload` (= publish, for this network) | Postiz | `direct` — REAL resumable upload, contract-tested (38d), now with real title/description (38e, Gap 2) | Credential-gated (same as LinkedIn) **AND** a second, independent gap: `dispatch.ts` unconditionally calls `schedulePost` after any media upload, for every network — a shape that fits LinkedIn's real API but not YouTube's ("upload IS publish", no separate schedule step). Routing `youtube:media_upload` to `direct` on a live dispatch call today would upload a real video and then attempt a doomed second `schedulePost` step. **This is reported to the architect as its own open question (see `provisioning.ts#resolveDispatchOrgHandle`'s own header) — deliberately NOT wired into the recommended flip config below.** Principle-only for TWO independent reasons, not one |
| YouTube | `quota_probe` | n/a — Postiz never advertised this for YouTube | `direct` — REAL accounting (38d) against a NOW-DURABLE store (38e, Gap 3: `social_youtube_quota_usage`, global, no RLS, D-4's own reasoning) | Only reachable once `media_upload`/a future `videos.insert` caller exists on a live path — see the row above |
| YouTube | `inbox_read` (`pullComments`) | n/a — Postiz has no inbox surface | `direct` — REAL comment read via `youtube.force-ssl` (38d) | Credential-gated + SMM-15, same as LinkedIn's row |
| Instagram / Facebook | everything | Postiz (AGPL zone) | **not built** — `direct` has zero IG/FB capability | Meta Business Verification (staging, D-23) is the serial prerequisite before ANY IG/FB work on `direct` would even be worth starting (§PD: "IG/FB stay on Postiz") |
| TikTok | everything | Postiz (AGPL zone, D-21 fork exception) | **not built** — `direct` has zero TikTok capability | TikTok's own audit (staging, D-23); §PD: "TikTok stays behind its own audit" |

**The flip itself (38e) does NOT change the shipped default.** `config.social.publisher.capabilityDrivers`
stays the empty map every prior phase shipped — every deployment with no
`SOCIAL_PUBLISHER_CAPABILITY_DRIVERS` set behaves EXACTLY as before this phase, for every network,
including LinkedIn and YouTube. The recommended override for a deployment that HAS cleared LinkedIn's
credential gate (D-23) is `linkedin:schedule=direct,linkedin:media_upload=direct,linkedin:inbox_read=direct`
— deliberately never `youtube:media_upload=direct` or any `youtube:schedule` key, for the reason named
in the table above. Setting an override is an explicit, staging-time operator action; nothing in this
phase makes that decision on a deployment's behalf.

**Why "principle-only" is the honest word, twice over, for two different reasons in this wave:**
(1) every platform app credential in the estate is empty (D-23, deferred to staging) — true for LinkedIn
AND YouTube equally; (2) YouTube ALSO carries a second, independent gap that has nothing to do with
credentials — the dispatch state machine itself does not yet know how to represent a network whose
publish terminates at `uploadMedia`. Naming both, rather than collapsing them into one "not live yet"
sentence, is what lets a future pass tell "get a credential" apart from "redesign a flow" — two very
different amounts of work hiding behind the same word.

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

- **18 MCP tools declared** (`modules/social/index.ts`), covering roughly a third of the ~40
  distinct HTTP capabilities enumerated above. The tracker's prior estimate of "17" undercounted by
  one; corrected here and in `docs/plans/smm-tracker.md`.
- **`social.publishPost` IS declared and IS the D14-registered executable** (`write:true,
  impact:'high'`); `social.publishPostMetered` is barred and correctly never declared. (The prior
  seat's contrary finding was traced to grepping the literal string instead of the
  `SOCIAL_PUBLISH_TOOL` constant — see `docs/plans/smm-tracker.md`'s defect-class §4b.)
- **Two structural coverage gaps, both real, neither previously written down in one place:**
  1. **The entire client-review capability group (request/read/withdraw + the portal decide) has no
     MCP tool.** An agent cannot participate in the client sign-off loop at all.
  2. **Every plain single-resource read/update/delete (engagement, post, variant, brand profile,
     campaign, KPI target) has no MCP tool** — only list/create/scope-style capabilities got one.
     This may be intentional (a smaller declared surface is safer), but it has never been stated as
     a decision anywhere this pass found.
- **`work_activity` coverage is broad but not total.** 18 `writeActivity()` call sites cover nearly
  every human-triggered write. The one gap this pass found and named: **the post-status webhook
  callback (`reconcileOneProviderPost`) writes no `work_activity` row**, and unlike the purge/metrics
  jobs, nobody has stated whether that is a considered decision or an oversight.
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
