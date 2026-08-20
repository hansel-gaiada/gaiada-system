// SMM-38/38a — the `direct` driver SKELETON (owner decision D-20).
//
// D-20 chose a second, free `SocialPublisher` implementation switched in per capability, so the
// AGPL zone, both fork exceptions and the P2 inbox gap can be removed without forking Postiz —
// design addendum §PD. This file is phase 38a's entire contribution to that build: a driver that
// conforms to the port's SHAPE and refuses every member HONESTLY. It is not a stub that half-works;
// it is a driver that tells the truth about what it cannot do yet.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO (38b/38c/38d's job, not this one's) ──────────────────
// No OAuth, no token storage, no media upload, no network call — not even a health check. Every
// member below either throws `capability_unsupported` synchronously (wrapped in a rejected Promise
// by virtue of being declared `async`) or, for the port's two genuinely OPTIONAL members
// (`listComments`/`sendReply`/`getCreatorInfo`), is simply ABSENT — the exact "absent, not
// throwing" discipline types.ts's header established for a capability nobody has built yet (see
// item (a) there): a method that threw would read as a bug, while an absent one is the honest
// capability fact `capabilities.ts`'s three-reasons model already knows how to render ("driver
// cannot" — the same bucket Postiz's own inbox gap occupies today).
//
// ── WHY `capabilities` IS AN EMPTY SET, AND WHY THAT IS THE CORRECT ANSWER FOR 38a ────────────────
// Every capability-gated caller in this codebase (capabilities.ts's `resolveAccountCapabilities`,
// provisioning.ts's various `driver.capabilities.has(...)` guards, the shared contract suite this
// phase adds) checks the SET before ever calling a method. An empty set here means every one of
// those call sites already gets the right, honest answer without reaching a single method below —
// which is exactly why 38a can ship a driver nothing in the running system uses yet: nothing that
// checks capabilities first will ever be told this driver can do something it cannot.
//
// ── REGISTRATION — DELIBERATELY NOT WIRED INTO main.ts BY THIS PHASE ────────────────────────────
// `createDirectDriver()` is exported for the shared contract suite (`publisher-contract.ts`) and for
// 38b+ to register once there is a real reason to. It is NOT called from `boot.ts`/`main.ts` in
// 38a: `registry.ts`'s `resolvePublisher` treats an EMPTY registry as the deliberate signal
// `publisher_not_configured` (see its own header) precisely for the "Postiz is unset, nothing else
// is running either" deployment. Registering this driver unconditionally at boot would make that
// Map non-empty even when Postiz is unconfigured, which would silently change `resolvePublisher`'s
// refusal from `publisher_not_configured` to `unknown_publisher` for every existing org row — a
// live-behaviour change 38a's own acceptance bar forbids. Wiring `direct` into boot is therefore
// left to whichever phase first gives it a capability worth reaching (38b's custody work, at the
// earliest), at which point that phase also owns re-examining `resolvePublisher`'s empty-registry
// heuristic if it needs to.
import {
  OrgHandle,
  SocialPublisherError,
  type DailyMetrics,
  type DateRange,
  type IntegrationState,
  type OrgVerification,
  type PostMetrics,
  type PostStatus,
  type PublishOp,
  type PublisherCapability,
  type SocialPublisher,
  type VariantDispatch,
} from "./types";
import type { QuotaSnapshot } from "../media-rules";

/** Nothing is implemented yet. 38b adds token custody (still no network capability by itself),
 *  38c/38d add LinkedIn/YouTube — this set grows exactly once per phase that actually lands the
 *  capability, never ahead of what is built and verified. See publisher.test.ts's own "carries NO
 *  quota constant" regression-pin pattern for the sibling discipline this file must not violate
 *  either: nothing here may synthesize a capability it has not earned. */
const DIRECT_CAPABILITIES: PublisherCapability[] = [];

/** One refusal, one message shape, used by every required member below. `op` names the exact port
 *  method so an operator (or an agent) reading the error knows precisely what to wait for and which
 *  phase brings it — never a generic "not implemented". */
function refuseUnsupported(op: string): never {
  throw new SocialPublisherError(
    "capability_unsupported",
    `the 'direct' driver does not implement '${op}' yet — phase 38a ships the skeleton only `
    + "(SMM-38, design addendum §PD); OAuth, token custody, media upload and the per-network builds "
    + "land in 38b-38d",
  );
}

export function createDirectDriver(): SocialPublisher {
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
      return refuseUnsupported("connectUrl");
    },

    async listIntegrations(_org: OrgHandle): Promise<IntegrationState[]> {
      return refuseUnsupported("listIntegrations");
    },

    async getQuota(_org: OrgHandle, _integration: IntegrationState): Promise<QuotaSnapshot | undefined> {
      return refuseUnsupported("getQuota");
    },

    // getCreatorInfo stays ABSENT (D-22/D-21's TikTok-only fork-exception concern does not apply to
    // this driver at all — TikTok stays on Postiz per §PD's own "what SMM-38 does NOT do").

    async schedulePost(_org: OrgHandle, _req: VariantDispatch): Promise<{ providerPostId: string }> {
      return refuseUnsupported("schedulePost");
    },

    async cancelPost(_org: OrgHandle, _providerPostId: string): Promise<void> {
      return refuseUnsupported("cancelPost");
    },

    async getPostStatus(_org: OrgHandle, _providerPostIds: string[], _range?: DateRange): Promise<PostStatus[]> {
      return refuseUnsupported("getPostStatus");
    },

    async uploadMedia(
      _org: OrgHandle,
      _file: { filename: string; contentType: string; bytes: Uint8Array },
    ): Promise<{ id: string; url?: string }> {
      return refuseUnsupported("uploadMedia");
    },

    async getAccountMetrics(_org: OrgHandle, _integrationId: string, _range: DateRange): Promise<DailyMetrics[]> {
      return refuseUnsupported("getAccountMetrics");
    },

    async getPostMetrics(_org: OrgHandle, _providerPostIds: string[]): Promise<PostMetrics[]> {
      return refuseUnsupported("getPostMetrics");
    },

    // listComments / sendReply stay ABSENT — see the file header. Nothing is implemented, so
    // nothing is advertised, and there is no method here that could be mistaken for a bug rather
    // than a capability fact.

    estimateCostUsd(_op: PublishOp): number {
      // Pure + synchronous per the port (types.ts's PublishOp doc). $0 is correct, not a placeholder:
      // this driver cannot dispatch to ANY network yet, metered or not, so there is no cost to price.
      return 0;
    },
  };
}
