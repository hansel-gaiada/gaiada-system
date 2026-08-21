// SMM-38 — the `direct` driver, D-20's second `SocialPublisher` implementation.
//
// 38a shipped the SKELETON: every member refused `capability_unsupported`, `capabilities` was an
// empty Set, and the file's whole argument was "nothing is implemented, and this is the honest way
// to say so." 38c (this phase, design addendum §PD) gives it its first REAL capability: LinkedIn's
// org-page publish, media upload, and comment read. Everything this file does NOT cover — every
// other network, and every LinkedIn method not listed below — still refuses exactly as 38a left it.
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
// LinkedIn access token (never a key alias), and `org.orgId` is the target LinkedIn organization URN
// (`urn:li:organization:...`) — both resolved by the caller. `org.publisherOrgId` carries whatever
// our-row id the caller wants named on a span/audit line (naturally `social_accounts.id`, since
// `direct` has no separate "org" concept the way Postiz does — an ACCOUNT is the granular unit here).
//
// **WHO BUILDS THAT HANDLE, TODAY: NOBODY ON A LIVE PATH.** `dispatch.ts` and
// `provisioning.ts#openOrg` are the only two places a `SocialPublisher` call is made against a real
// `OrgHandle` today, and both are Postiz-shaped: `openOrg` builds `new OrgHandle(org.id,
// org.postizOrgId, resolveOrgApiKey(org.apiKeyRef))` from `social_publisher_orgs`, which has no
// notion of a per-account OAuth token at all. Wiring "resolve this account's LinkedIn token, then
// build a `direct`-shaped `OrgHandle` from it" into either of those call sites is real surgery this
// phase's file surface does not include (`dispatch.ts` is off-limits; `provisioning.ts` is not this
// ticket's to restructure) — it is 38e's job, the SAME phase whose own exit criterion is "flip
// LinkedIn + YouTube publishing to `direct` in config". Named here, not silently worked around: this
// phase proves the driver's LinkedIn methods are correct against a resolved token (contract tests +
// `direct.test.ts`'s own LinkedIn cases), but nothing on a live dispatch path constructs that token
// or that handle yet. See `linkedin-oauth.ts`'s header for the piece that DOES land on a live path
// this phase — acquiring and storing the grant in the first place.
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
import type { QuotaSnapshot } from "../media-rules";
import {
  getPostComments,
  publishOrganizationPost,
  registerImageUpload,
  uploadImageBytes,
  type LinkedInFetchOptions,
} from "./linkedin-client";

/** LinkedIn's org-page publish, media upload and comment read are real as of 38c. Every other
 *  capability (org_create, org_verify, connect_url, integrations, quota_probe, cancel, post_status,
 *  account_metrics, post_metrics, inbox_reply, creator_info_probe) stays unimplemented — see the
 *  header for `inbox_reply` specifically (SMM-17, gated on SMM-15, out of this phase's scope). */
const DIRECT_CAPABILITIES: PublisherCapability[] = ["schedule", "media_upload", "inbox_read"];

/** One refusal, one message shape, used by every member 38c still leaves unimplemented. Unchanged
 *  from 38a except the phase number, since 38a's own instruction ("op names the exact port method")
 *  still applies verbatim to what remains unimplemented. */
function refuseUnsupported(op: string): never {
  throw new SocialPublisherError(
    "capability_unsupported",
    `the 'direct' driver does not implement '${op}' yet — SMM-38 (design addendum §PD); OAuth, `
    + "org-page publish, media upload and comment read for LinkedIn land in 38c, YouTube in 38d",
  );
}

/** The per-network gate every 38c-real method applies AFTER its own structural checks (approval id,
 *  etc.) — see the header's "how a driver-wide capability coexists with per-network coverage". */
function refuseNetworkNotCovered(op: string, network: string): never {
  throw new SocialPublisherError(
    "capability_unsupported",
    `the 'direct' driver advertises '${op}' but does not yet cover network '${network}' for it — `
    + "only LinkedIn is implemented as of SMM-38 phase 38c; YouTube lands in 38d",
  );
}

export interface DirectDriverOptions {
  /** Injected in tests so no real socket is ever opened — mirrors postiz.ts's own `fetchImpl` seam. */
  fetchImpl?: typeof fetch;
}

export function createDirectDriver(opts: DirectDriverOptions = {}): SocialPublisher {
  const li: LinkedInFetchOptions = { fetchImpl: opts.fetchImpl };

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

    async getQuota(_org: OrgHandle, _integration: IntegrationState): Promise<QuotaSnapshot | undefined> {
      // LinkedIn's Standard-tier rate limits are UNPUBLISHED (dossier §4.4) — there is no live probe
      // endpoint to call even if this driver covered `quota_probe`, and inventing a number here
      // would be exactly the "confident wrong answer" capabilities.ts's own header forbids. Stays
      // unimplemented; `quota_probe` is not in `DIRECT_CAPABILITIES`.
      return refuseUnsupported("getQuota");
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
    ): Promise<{ id: string; url?: string }> {
      // ⚠ THE NETWORK-ROUTING GAP THIS METHOD CANNOT CLOSE ITSELF: the port's `uploadMedia` carries
      // NO `network` parameter at all (types.ts), unlike `schedulePost`/`listComments`, which get it
      // from `VariantDispatch.network` / the caller's own context. As of 38c only LinkedIn's asset
      // flow is implemented, so this method always attempts it — correct BY ELIMINATION today, and
      // WRONG the moment 38d adds a second real network. 38d must resolve this (with the architect,
      // if the port itself needs a `network` parameter added to `uploadMedia`) — not silently papered
      // over here by guessing from `file.contentType`, which cannot distinguish LinkedIn from YouTube.
      const registered = await registerImageUpload(org.secret(), org.orgId, li);
      await uploadImageBytes(registered.uploadUrl, file.bytes, file.contentType, li);
      return { id: registered.assetUrn };
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
     *  ⚠ `integrationId` HERE NAMES A POST'S `providerPostId` (LinkedIn share URN), NOT a connected
     *  ACCOUNT's integration id — a deliberate, documented departure from how the port's doc describes
     *  this parameter for an account-wide inbox (types.ts's `listComments` doc, written against
     *  Postiz's — nonexistent — inbox model). LinkedIn's Community Management API has no "every
     *  comment across my organization page" endpoint; comments are read PER SHARE
     *  (`GET /rest/socialActions/{shareUrn}/comments`, dossier §4.2). SMM-15 (P2 inbox sync, whenever
     *  it is built) must call this once per published LinkedIn post it wants freshly pulled, not once
     *  per connected account — the `InboxItem[]` shape returned is exactly what SMM-36's retention
     *  purge already reaches once ingested: `authorHandle`/`authorName`/`body`/`postedAt` map
     *  directly onto `social_inbox_threads`/`social_inbox_messages`' own columns
     *  (`inbox-retention-job.ts`), which already purge ANY network tagged `linkedin` generically —
     *  no purge-side change was needed for this shape to be reachable. */
    async listComments(org: OrgHandle, integrationId: string, since: Date): Promise<InboxItem[]> {
      return getPostComments(org.secret(), integrationId, since, li);
    },

    // sendReply stays ABSENT — SMM-17 (reply flow), gated on SMM-15, is out of this phase's scope
    // per the ticket brief's own scope line ("OAuth, org-page publish, media upload, pullComments").

    estimateCostUsd(_op: PublishOp): number {
      // LinkedIn is not metered (design §05/OQ-2 — only X is, and X ships disabled regardless).
      return 0;
    },
  };
}
