// SMM-38 — the `direct` driver, D-20's second `SocialPublisher` implementation.
//
// 38a shipped the SKELETON: every member refused `capability_unsupported`, `capabilities` was an
// empty Set, and the file's whole argument was "nothing is implemented, and this is the honest way
// to say so." 38c (design addendum §PD) gave it its first REAL capability: LinkedIn's org-page
// publish, media upload, and comment read. 38d (this phase) adds YouTube's resumable video upload,
// quota ACCOUNTING against the three real buckets, and comment read via `youtube.force-ssl` —
// YouTube does NOT get `schedulePost`, deliberately (see that method's own comment): a YouTube
// `videos.insert` call IS the post, not a separate publish step referencing an already-uploaded
// asset the way LinkedIn's flow works, so `uploadMedia` itself is YouTube's publish mechanism in
// this driver's shape. Everything this file does NOT cover — every other network, and every
// LinkedIn/YouTube method not listed below — still refuses exactly as 38a left it.
//
// ── HOW A DRIVER-WIDE CAPABILITY COEXISTS WITH PER-NETWORK COVERAGE ─────────────────────────────
// `PublisherCapability` (types.ts) is DRIVER-wide, not per-network — the port has no `(network,
// capability)` granularity at the capability-Set level (that granularity lives one layer up, in
// `registry.ts`'s `resolvePublisherForCapability`, which routes a (network, capability) PAIR to a
// driver — it does not ask the driver "which networks do you cover for this capability"). `direct`
// will genuinely cover LinkedIn now and YouTube in 38d, on DIFFERENT schedules, so advertising
// `schedule`/`media_upload`/`inbox_read` driver-wide while only LinkedIn is real is the SAME shape
// `postiz.ts` already uses for `getQuota`/`getCreatorInfo` — capability advertised at the driver
// level, a network-gate INSIDE the method body, and a TYPED refusal (never a crash) for a network
// the method does not yet cover. `schedulePost`/`uploadMedia`/`listComments` below all follow this
// exact pattern: check the approval/args shape first, then branch on `network`, and name the gap
// honestly (`capability_unsupported`, "the 'direct' driver does not yet cover '<network>' for
// '<op>'") for anything that is not LinkedIn yet. **This is a real, load-bearing gap for 38d to
// inherit**: the port's capability model cannot express "schedule: true for LinkedIn, false for
// YouTube" at the Set level, and 38d must decide (with the architect, if it wants to change the
// port) whether that stays a per-method network branch forever, or whether the port itself grows a
// per-network capability shape. Not decided here — named, not silently worked around.
//
// ── THE CREDENTIAL SHAPE: `OrgHandle.secret()` CARRIES A RESOLVED BEARER TOKEN, NOT AN ORG API KEY
// `OrgHandle` (types.ts) was built for Postiz's custody model: one API key PER ORG, resolved by
// alias at call time (`publisher/keys.ts`). `direct` has no such thing — LinkedIn's credential is a
// per-ACCOUNT OAuth bearer token, resolved from `social_oauth_tokens` via
// `oauth-tokens.ts#resolveActiveAccessToken`, which needs a `PoolClient` and a tenant-scoped
// transaction. The port's own method signatures (`schedulePost(org, req)`, `uploadMedia(org, file)`,
// `listComments(org, integrationId, since)`) carry NEITHER a `PoolClient` NOR a tenantId — by
// design, per the port's own containment rule ("drivers are stateless per call... a process-level
// singleton holding a tenant's credential is how one tenant's key serves another's call", types.ts
// header). So the token MUST be resolved by the CALLER, before this driver is ever invoked, exactly
// the way `dispatch.ts` already resolves `org.secret()` from `social_publisher_orgs.api_key_ref`
// before calling `driver.schedulePost`.
//
// **This file therefore repurposes `OrgHandle` for `direct`**: `org.secret()` is the ALREADY-RESOLVED
// access token (never a key alias, LinkedIn OR YouTube), and for LinkedIn `org.orgId` is the target
// organization URN (`urn:li:organization:...`) — both resolved by the caller. For YouTube, `org.orgId`
// is UNUSED by every 38d method (YouTube's `videos.insert`/`commentThreads.list` calls identify the
// channel implicitly from the bearer token itself — there is no separate "organization id" a YouTube
// call needs to name, unlike LinkedIn's org-page publish); callers may pass the connected
// `social_accounts.id` there too, purely for span/audit naming, exactly as `publisherOrgId` already
// does. `org.publisherOrgId` carries whatever our-row id the caller wants named on a span/audit line
// (naturally `social_accounts.id`, since `direct` has no separate "org" concept the way Postiz does —
// an ACCOUNT is the granular unit here, for both networks).
//
// **WHO BUILDS THAT HANDLE, TODAY: NOBODY ON A LIVE PATH.** `dispatch.ts` and
// `provisioning.ts#openOrg` are the only two places a `SocialPublisher` call is made against a real
// `OrgHandle` today, and both are Postiz-shaped: `openOrg` builds `new OrgHandle(org.id,
// org.postizOrgId, resolveOrgApiKey(org.apiKeyRef))` from `social_publisher_orgs`, which has no
// notion of a per-account OAuth token at all. Wiring "resolve this account's LinkedIn/YouTube token,
// then build a `direct`-shaped `OrgHandle` from it" into either of those call sites is real surgery
// this phase's file surface does not include (`dispatch.ts` is off-limits; `provisioning.ts` is not
// this ticket's to restructure) — it is 38e's job, the SAME phase whose own exit criterion is "flip
// LinkedIn + YouTube publishing to `direct` in config". Named here, not silently worked around: this
// phase (and 38c before it) prove the driver's LinkedIn/YouTube methods are correct against a
// resolved token (contract tests + `direct.test.ts`'s own cases for both networks), but nothing on a
// live dispatch path constructs that token or that handle yet. See `linkedin-oauth.ts`'s/
// `youtube-oauth.ts`'s own headers for the piece that DOES land on a live path each phase — acquiring
// and storing the grant in the first place, through each network's own OAuth controller.
import {
  OrgHandle,
  SocialPublisherError,
  type DailyMetrics,
  type DateRange,
  type IntegrationState,
  type InboxItem,
  type OrgVerification,
  type PostMetrics,
  type PostStatus,
  type PublishOp,
  type PublisherCapability,
  type SocialPublisher,
  type VariantDispatch,
} from "./types";
import type { Network, QuotaSnapshot } from "../media-rules";
import {
  getPostComments,
  publishOrganizationPost,
  registerImageUpload,
  uploadImageBytes,
  type LinkedInFetchOptions,
} from "./linkedin-client";
import {
  initiateResumableUpload,
  listVideoCommentThreads,
  uploadVideoBytes,
  type YouTubeFetchOptions,
} from "./youtube-client";
import { getYouTubeQuotaSnapshot, recordYouTubeQuotaUsage } from "./youtube-quota";

/** LinkedIn's org-page publish, media upload and comment read are real as of 38c. 38d adds YouTube's
 *  media upload, quota accounting (`quota_probe` — see `getQuota`'s own comment for why this is
 *  honest for YouTube even though it is NOT a live probe) and comment read. Every other capability
 *  (org_create, org_verify, connect_url, integrations, cancel, post_status, account_metrics,
 *  post_metrics, inbox_reply, creator_info_probe) stays unimplemented — see the header for
 *  `inbox_reply` specifically (SMM-17, gated on SMM-15, out of this phase's scope). Note `schedule`
 *  stays LinkedIn-only: YouTube never gets it in this phase (see `schedulePost`'s own comment). */
const DIRECT_CAPABILITIES: PublisherCapability[] = ["schedule", "media_upload", "inbox_read", "quota_probe"];

/** One refusal, one message shape, used by every member 38c/38d still leave unimplemented. Unchanged
 *  in shape from 38a except the phase number, since 38a's own instruction ("op names the exact port
 *  method") still applies verbatim to what remains unimplemented. */
function refuseUnsupported(op: string): never {
  throw new SocialPublisherError(
    "capability_unsupported",
    `the 'direct' driver does not implement '${op}' yet — SMM-38 (design addendum §PD); LinkedIn's `
    + "OAuth/org-page publish/media upload/comment read landed in 38c, YouTube's resumable upload/"
    + "quota accounting/comment read landed in 38d — this member is unimplemented for every network",
  );
}

/** The per-network gate every 38c/38d-real method applies AFTER its own structural checks (approval
 *  id, etc.) — see the header's "how a driver-wide capability coexists with per-network coverage". */
function refuseNetworkNotCovered(op: string, network: string): never {
  throw new SocialPublisherError(
    "capability_unsupported",
    `the 'direct' driver advertises '${op}' but does not cover network '${network}' for it — as of `
    + "SMM-38 phase 38d, LinkedIn and YouTube each cover a DIFFERENT subset of this driver's real "
    + "capabilities (see direct.ts's own header); every other network stays fully unimplemented",
  );
}

export interface DirectDriverOptions {
  /** Injected in tests so no real socket is ever opened — mirrors postiz.ts's own `fetchImpl` seam. */
  fetchImpl?: typeof fetch;
}

export function createDirectDriver(opts: DirectDriverOptions = {}): SocialPublisher {
  const li: LinkedInFetchOptions = { fetchImpl: opts.fetchImpl };
  const yt: YouTubeFetchOptions = { fetchImpl: opts.fetchImpl };

  return {
    key: "direct",
    capabilities: new Set<PublisherCapability>(DIRECT_CAPABILITIES),

    async createOrg(): Promise<{ orgId: string; apiKeyRef: string }> {
      return refuseUnsupported("createOrg");
    },

    async verifyOrg(_org: OrgHandle): Promise<OrgVerification> {
      return refuseUnsupported("verifyOrg");
    },

    async connectUrl(_org: OrgHandle, _network, _redirect: string): Promise<string> {
      // Deliberately STILL unimplemented via the port, even though a real LinkedIn OAuth start
      // exists as of 38c — see `linkedin-oauth.ts`'s header for why: this method's signature
      // (`org: OrgHandle, network, redirect: string`) carries no tenantId/accountId, and a real
      // per-account OAuth grant acquisition needs both to create/resume the pending
      // `social_accounts` row and to mint a CSRF-bound state. Retrofitting that context into this
      // signature would either lie about what the call needs or silently redefine the port's
      // contract — neither of which this phase does without an architect decision. `direct`'s
      // LinkedIn OAuth flow is therefore a STANDALONE subsystem (`linkedin-oauth.ts` +
      // `linkedin-oauth.controller.ts`), reached through its own endpoints, not through this method.
      return refuseUnsupported("connectUrl");
    },

    async listIntegrations(_org: OrgHandle): Promise<IntegrationState[]> {
      return refuseUnsupported("listIntegrations");
    },

    async getQuota(_org: OrgHandle, integration: IntegrationState): Promise<QuotaSnapshot | undefined> {
      // `quota_probe` IS now advertised driver-wide (38d, for YouTube) — so a network this driver
      // does not cover for it refuses via `refuseNetworkNotCovered`, not `refuseUnsupported` (the
      // header's own "driver-wide capability plus per-network gate" discipline).
      if (integration.network !== "youtube") {
        // LinkedIn's Standard-tier rate limits are UNPUBLISHED (dossier §4.4) — there is no live
        // probe endpoint to call for LinkedIn even now that this driver covers `quota_probe` for
        // YouTube, and inventing a number here would be exactly the "confident wrong answer"
        // capabilities.ts's own header forbids. Unchanged from 38c's own reasoning.
        return refuseNetworkNotCovered("getQuota", integration.network);
      }
      // YouTube: this is ACCOUNTING, not a live probe — see `youtube-quota.ts`'s own header for why
      // that is the honest answer here (no live "remaining quota" endpoint exists, and the cap is a
      // documented per-PROJECT constant, not a per-account fact to ask Google for). Same snapshot for
      // every YouTube account this deployment connects (the dossier's own finding: the cap is shared
      // across the entire fleet, not per client).
      return { youtubeQuota: getYouTubeQuotaSnapshot() };
    },

    // getCreatorInfo stays ABSENT — TikTok-only concern (D-21/D-22), out of scope for a driver that
    // does not serve TikTok at all (§PD: "what SMM-38 does NOT do").

    async schedulePost(org: OrgHandle, req: VariantDispatch): Promise<{ providerPostId: string }> {
      // D-6, checked FIRST and unconditionally — exactly like postiz.ts's own schedulePost, and
      // exactly what lets the shared contract suite's "approval_required if it can schedule at all"
      // case pass regardless of which network fixture it happens to run with (publisher-contract.ts).
      if (!req.approvalId) {
        throw new SocialPublisherError(
          "approval_required",
          "publisher refused a dispatch with no one-shot approval id (design D-6): approved content only",
        );
      }
      if (req.network !== "linkedin") {
        // YouTube is deliberately EXCLUDED here too, not just "not yet covered": 38d's own scope is
        // "resumable upload + pullComments", never `schedulePost` — a YouTube `videos.insert` call
        // IS the post (see `uploadMedia` below), so there is no separate "publish an already-uploaded
        // asset" step for this driver to implement for YouTube at all. Refusing the SAME
        // `capability_unsupported` a truly-uncovered network would get is still the honest answer:
        // callers must not learn a fake distinction between "not yet built" and "will never exist for
        // this network" from the refusal code alone (the driver-wide `schedule` capability + the
        // per-network gate is `postiz.ts`'s own established shape for exactly this ambiguity).
        return refuseNetworkNotCovered("schedulePost", req.network);
      }
      // See the file header: `org.secret()` is the ALREADY-RESOLVED LinkedIn access token, never an
      // org API key alias, and `org.orgId` is the target organization URN. Neither is resolved here.
      return publishOrganizationPost(
        org.secret(),
        {
          organizationUrn: org.orgId,
          commentary: req.body,
          mediaUrns: (req.media ?? []).map((m) => m.id),
        },
        li,
      );
    },

    async cancelPost(_org: OrgHandle, _providerPostId: string): Promise<void> {
      // ⚠UNVERIFIED whether LinkedIn's Posts API even offers a delete/retract route for an already-
      // PUBLISHED post (dossier §4.5 found no native SCHEDULING at all, and cancellation of a live
      // post is a different, unresearched question) — refusing honestly rather than guessing at a
      // route this driver has never been told exists.
      return refuseUnsupported("cancelPost");
    },

    async getPostStatus(_org: OrgHandle, _providerPostIds: string[], _range?: DateRange): Promise<PostStatus[]> {
      return refuseUnsupported("getPostStatus");
    },

    async uploadMedia(
      org: OrgHandle,
      file: { filename: string; contentType: string; bytes: Uint8Array },
      network: Network,
    ): Promise<{ id: string; url?: string }> {
      // 38d resolves the network-routing gap 38c named: the port's `uploadMedia` now carries
      // `network` (types.ts's own header), so this method branches explicitly instead of guessing
      // from `file.contentType` (which cannot distinguish LinkedIn's asset flow from YouTube's
      // resumable one — both accept the same image/video content types).
      if (network === "linkedin") {
        const registered = await registerImageUpload(org.secret(), org.orgId, li);
        await uploadImageBytes(registered.uploadUrl, file.bytes, file.contentType, li);
        return { id: registered.assetUrn };
      }
      if (network === "youtube") {
        // YouTube's resumable upload IS the publish call for this driver (see `schedulePost`'s own
        // comment) — `videos.insert` creates the video resource directly, there is no separate
        // "reference this asset from a later post" step the way LinkedIn's flow works. Metadata is
        // deliberately MINIMAL: `uploadMedia`'s own signature carries no title/description field
        // beyond `{filename, contentType, bytes}` (widening it further than the single `network`
        // parameter this collision required was NOT this ticket's call to make unilaterally — see
        // `youtube-client.ts#ResumableUploadMetadata`'s own comment), so `title` is derived from the
        // filename and `privacyStatus` defaults to `private` (the SAFE default that happens to match
        // the dossier's own UNVERIFIED forced-private-lock report — see that file's header). Named,
        // load-bearing gap for whoever wires this to a live dispatch path (38e): real video
        // title/description drawn from the variant's own body has nowhere to travel through this
        // call today.
        const initiated = await initiateResumableUpload(
          org.secret(), { title: file.filename, privacyStatus: "private" }, file.bytes.byteLength, file.contentType, yt,
        );
        const uploaded = await uploadVideoBytes(initiated.uploadUrl, file.bytes, file.contentType, yt);
        // Recorded ONLY after both calls succeed — see youtube-quota.ts's own header on why a failed
        // call is never counted as used quota.
        recordYouTubeQuotaUsage("videosInsertCallsToday", 1);
        return { id: uploaded.videoId };
      }
      return refuseNetworkNotCovered("uploadMedia", network);
    },

    async getAccountMetrics(_org: OrgHandle, _integrationId: string, _range: DateRange): Promise<DailyMetrics[]> {
      return refuseUnsupported("getAccountMetrics");
    },

    async getPostMetrics(_org: OrgHandle, _providerPostIds: string[]): Promise<PostMetrics[]> {
      return refuseUnsupported("getPostMetrics");
    },

    /** SMM-38c — the reason this whole phase exists (P2's `pullComments`). PRESENT, not absent,
     *  because `inbox_read` is now a real capability — matching the port's own "absent IS the
     *  finding" discipline in the other direction: a capability that IS implemented must not stay
     *  optionally-undefined, or a caller checking `capabilities.has('inbox_read')` before calling
     *  would find nothing to call.
     *
     *  ⚠ `integrationId` HERE NAMES A POST'S `providerPostId` (a LinkedIn share URN OR a YouTube
     *  video id), NOT a connected ACCOUNT's integration id — a deliberate, documented departure from
     *  how the port's doc describes this parameter for an account-wide inbox (types.ts's
     *  `listComments` doc, written against Postiz's — nonexistent — inbox model). Neither network's
     *  API has an "every comment across my whole account" endpoint; both read PER POST (LinkedIn:
     *  `GET /rest/socialActions/{shareUrn}/comments`, dossier §4.2; YouTube:
     *  `commentThreads.list?videoId=...`, dossier §6.2). SMM-15 (P2 inbox sync, whenever it is built)
     *  must call this once per published post it wants freshly pulled, not once per connected
     *  account.
     *
     *  ── HOW THIS METHOD TELLS THE TWO NETWORKS APART, GIVEN THE PORT HAS NO `network` PARAMETER
     *  HERE — a DIFFERENT, DELIBERATELY NARROWER answer than `uploadMedia`'s fix ────────────────────
     *  Unlike `uploadMedia`, this ticket's scope did not name `listComments` as needing the port's
     *  signature widened, and there is a real, principled signal to branch on WITHOUT one: LinkedIn's
     *  entire id namespace is URN-shaped by the network's OWN wire format (`urn:li:share:...` —
     *  mandated by LinkedIn's API, not a convention this codebase invented), while a YouTube video id
     *  is never a URN. This is NOT the same class of guess `uploadMedia`'s old `file.contentType`
     *  branch would have been (both networks there accept identical content types — no tell exists);
     *  here the network's own id format IS the tell. Named as a deliberate, narrower alternative to
     *  widening a second port method — a real `network` parameter on `listComments` is a cleaner
     *  long-term answer and is left to the architect/38e/SMM-15, whichever first needs a case this
     *  heuristic cannot cover (e.g. a network whose ids also happen to start with `urn:li:`, which
     *  does not exist among the networks 0105 admits today). */
    async listComments(org: OrgHandle, integrationId: string, since: Date): Promise<InboxItem[]> {
      if (integrationId.startsWith("urn:li:")) {
        return getPostComments(org.secret(), integrationId, since, li);
      }
      const items = await listVideoCommentThreads(org.secret(), integrationId, since, yt);
      // commentThreads.list costs 1 unit against the 10,000/day pool (dossier §6.4) — recorded only
      // after the call succeeded, same discipline as uploadMedia's own accounting call.
      recordYouTubeQuotaUsage("otherUnitsToday", 1);
      return items;
    },

    // sendReply stays ABSENT — SMM-17 (reply flow), gated on SMM-15, is out of this phase's scope
    // per the ticket brief's own scope line ("OAuth, org-page publish, media upload, pullComments").

    estimateCostUsd(_op: PublishOp): number {
      // Neither LinkedIn nor YouTube is metered (design §05/OQ-2 — only X is, and X ships disabled
      // regardless).
      return 0;
    },
  };
}
