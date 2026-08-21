// SMM-05 — the in-memory publisher driver the suites run against.
//
// Mirrors modules/search/providers/mock-provider.ts's role: the port's contract tests, the
// provisioning tests and the connector-sync tests all drive THIS, so nothing in `npx vitest run
// src/modules/social` needs a live Postiz. That is a hard requirement of this ticket, not a
// convenience — Postiz is not deployed (SMM-04 is PROTOTYPED, the VPS retarget is planned but
// nothing has been run on either host), and a suite that needs it would be a suite nobody can run.
//
// ⚠ IT IS A TEST DOUBLE, NOT A SIMULATOR, and the difference is deliberate. The search module ships
// SM-33 *simulated providers* that mint synthetic rows a deployment can demo against, with a
// `simulated` provenance marker and a boot-time mutual-exclusion assertion because a simulated row
// reaching a client report is a real hazard. Nothing analogous is wanted here: a "simulated
// publish" would be a post that never appeared on a client's account while our calendar said it
// did — worse than an outage, because it is silent. So this driver is exported for tests, is never
// registered by main.ts under any flag, and containment.test.ts pins that absence.
import type { QuotaSnapshot } from "../media-rules";
import {
  OrgHandle,
  SocialPublisherError,
  type CreatorInfoSnapshot,
  type DailyMetrics,
  type DateRange,
  type IntegrationState,
  type OrgVerification,
  type PostMetrics,
  type PostStatus,
  type PublisherKey,
  type PublishOp,
  type PublisherCapability,
  type SocialPublisher,
  type VariantDispatch,
} from "./types";
import { X_POST_USD, X_POST_WITH_LINK_USD } from "./postiz";

export interface MockPublisherState {
  /** Integrations the fake org reports, keyed by org id. */
  integrations: Map<string, IntegrationState[]>;
  /** Live quota the probe returns, keyed by integration id. Absent ⇒ `undefined` (unknown). */
  quota: Map<string, QuotaSnapshot>;
  /** SMM-10/D-22 — the live `creator_info` snapshot the probe returns, keyed by integration id.
   *  Absent ⇒ `undefined` (probe unavailable), matching `quota`'s own convention. */
  creatorInfo: Map<string, CreatorInfoSnapshot>;
  posts: Map<string, PostStatus>;
  /** Every call made, for assertions: op name + the org id it used. NEVER the key — the suite
   *  asserting "the key never leaves" must not itself become the place it leaks. */
  calls: Array<{ op: string; orgId: string }>;
  /** Set to make the next call throw — how the tests drive "Postiz is unreachable". */
  failWith?: SocialPublisherError;
  /** SMM-39 — filenames (as passed to `uploadMedia`) that must throw, independent of `failWith`.
   *  `failWith` is a blunt "everything from now on fails" flag; a partial-media-upload-failure test
   *  (attachment 2 of 3 fails, 1 and 3 must not) needs a PER-CALL failure a test can target by name
   *  without also failing the calls around it. */
  failUploadFilenames?: Set<string>;
  /** SMM-39 — the full request `schedulePost` was last called with, so a test can assert WHAT
   *  reached the engine (e.g. that `media` carries resolved `{id, url?}` refs, never the composer's
   *  raw `{fileId}` descriptors) rather than only that a call happened. */
  lastScheduleRequest?: VariantDispatch;
  /** SMM-38 phase 38d — the `network` `uploadMedia` was last called with (types.ts's own header:
   *  the port widened this call to carry it so a driver serving more than one network can tell
   *  which upload protocol to use). The mock does not branch on it (one generic fake upload for
   *  every network, matching Postiz's own real shape) but records it so a test can assert the
   *  CALLER passed the right one, the same reasoning as `lastScheduleRequest` above. */
  lastUploadNetwork?: string;
}

export function newMockPublisherState(): MockPublisherState {
  return { integrations: new Map(), quota: new Map(), creatorInfo: new Map(), posts: new Map(), calls: [] };
}

export interface MockPublisherOptions {
  /** Override the advertised capability set — how a test drives "a driver that CAN read an inbox"
   *  (the Mixpost-shaped case) without a second file. */
  capabilities?: PublisherCapability[];
  /** Advertise + implement the inbox surface. Default false: that is Postiz's real answer. */
  withInbox?: boolean;
  /** SMM-10/D-22 — advertise + implement `getCreatorInfo`. Default false: matching the real driver,
   *  where `creatorInfoProbeTool` is unset until D-21's fork exception is verified live. */
  withCreatorInfoProbe?: boolean;
  /** SMM-38 phase 38e — register this SAME mock shape under a different `PublisherKey`. Default
   *  `"postiz"` (unchanged from every existing caller). Lets a test register a SECOND mock under
   *  `"direct"` to prove `registry.ts#resolvePublisherForCapability`'s (network, capability) switch
   *  actually routes a live call to a different driver — this file otherwise has nothing that speaks
   *  `direct`'s real LinkedIn/YouTube wire shapes, and a contract-level fake is the right tool for
   *  proving ROUTING, as opposed to `direct.test.ts`'s own stub-`fetchImpl` cases, which prove the
   *  real driver's own wire behaviour. */
  key?: PublisherKey;
}

const DEFAULT_CAPS: PublisherCapability[] = [
  "org_verify", "connect_url", "integrations", "quota_probe", "schedule", "cancel",
  "post_status", "account_metrics", "post_metrics", "media_upload",
];

export function createMockPublisher(
  state: MockPublisherState,
  opts: MockPublisherOptions = {},
): SocialPublisher {
  const caps = new Set<PublisherCapability>(
    opts.capabilities ?? [
      ...DEFAULT_CAPS,
      ...(opts.withInbox ? (["inbox_read", "inbox_reply"] as PublisherCapability[]) : []),
      ...(opts.withCreatorInfoProbe ? (["creator_info_probe"] as PublisherCapability[]) : []),
    ],
  );
  const record = (op: string, org: OrgHandle): void => {
    state.calls.push({ op, orgId: org.orgId });
    if (state.failWith) throw state.failWith;
  };

  const driver: SocialPublisher = {
    key: opts.key ?? "postiz",
    capabilities: caps,

    async createOrg() {
      throw new SocialPublisherError("capability_unsupported", "mock driver does not create orgs (matching Postiz)");
    },
    async verifyOrg(org: OrgHandle): Promise<OrgVerification> {
      record("verifyOrg", org);
      return { ok: true, integrationCount: (state.integrations.get(org.orgId) ?? []).length };
    },
    async connectUrl(org: OrgHandle, network): Promise<string> {
      record("connectUrl", org);
      return `https://mock.invalid/connect/${network}`;
    },
    async listIntegrations(org: OrgHandle): Promise<IntegrationState[]> {
      record("listIntegrations", org);
      return state.integrations.get(org.orgId) ?? [];
    },
    async getQuota(org: OrgHandle, integration: IntegrationState): Promise<QuotaSnapshot | undefined> {
      record("getQuota", org);
      if (!caps.has("quota_probe")) return undefined;
      return state.quota.get(integration.id);
    },
    async getCreatorInfo(org: OrgHandle, integration: IntegrationState): Promise<CreatorInfoSnapshot | undefined> {
      record("getCreatorInfo", org);
      if (!caps.has("creator_info_probe")) return undefined;
      return state.creatorInfo.get(integration.id);
    },
    async schedulePost(org: OrgHandle, req: VariantDispatch): Promise<{ providerPostId: string }> {
      record("schedulePost", org);
      state.lastScheduleRequest = req;
      // The same structural D-6 assertion the real driver makes, so a test that reaches the mock
      // without an approval fails the same way production would.
      if (!req.approvalId) {
        throw new SocialPublisherError("approval_required", "mock publisher refused a dispatch with no approval id");
      }
      // GLOBALLY unique, not just unique within this MockPublisherState: 0105's
      // `ux_social_post_variants_provider` is a partial unique index over EVERY tenant's rows, so a
      // counter scoped to one test's fresh state (`state.posts.size`) collides with another test's
      // already-committed row of the same name the moment two tests each dispatch a "first" post —
      // SMM-10's dispatch.test.ts is what first exercised this driver against real, persisted rows
      // across multiple cases in one file rather than only asserting on in-memory state.
      const id = `mock-post-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      state.posts.set(id, { providerPostId: id, state: req.scheduledAt ? "queued" : "publishing" });
      return { providerPostId: id };
    },
    async cancelPost(org: OrgHandle, providerPostId: string): Promise<void> {
      record("cancelPost", org);
      state.posts.set(providerPostId, { providerPostId, state: "cancelled" });
    },
    async getPostStatus(org: OrgHandle, ids: string[], _range?: DateRange): Promise<PostStatus[]> {
      record("getPostStatus", org);
      return ids.map((id) => state.posts.get(id) ?? { providerPostId: id, state: "unknown" });
    },
    async uploadMedia(org: OrgHandle, file, network): Promise<{ id: string; url?: string }> {
      record("uploadMedia", org);
      state.lastUploadNetwork = network;
      if (state.failUploadFilenames?.has(file.filename)) {
        throw new SocialPublisherError("publisher_http_error", `mock upload refused ${file.filename}`);
      }
      return { id: `mock-media-${file.filename}`, url: `https://mock.invalid/media/${file.filename}` };
    },
    async getAccountMetrics(org: OrgHandle): Promise<DailyMetrics[]> {
      record("getAccountMetrics", org);
      return [];
    },
    async getPostMetrics(org: OrgHandle, ids: string[]): Promise<PostMetrics[]> {
      record("getPostMetrics", org);
      return ids.map((providerPostId) => ({ providerPostId }));
    },
    estimateCostUsd(op: PublishOp): number {
      if (op.network !== "x") return 0;
      return (op.hasLink ? X_POST_WITH_LINK_USD : X_POST_USD) * (op.items ?? 1);
    },
  };

  if (opts.withInbox) {
    driver.listComments = async (org: OrgHandle) => {
      record("listComments", org);
      return [];
    };
    driver.sendReply = async (org: OrgHandle) => {
      record("sendReply", org);
      return { externalId: "mock-reply" };
    };
  }
  return driver;
}
