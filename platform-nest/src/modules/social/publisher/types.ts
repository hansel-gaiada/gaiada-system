// SMM-05 — the `SocialPublisher` port (design smm-design.md §05), and THE AGPL CONTAINMENT LINE.
//
// Everything the platform ever sends to, or receives from, the publishing engine crosses this
// interface. One driver ships (`postiz`); the port exists so the documented Mixpost-Pro fallback
// (§06, SMM-28) is a driver swap rather than a redesign, and 0105 already admits `driver='mixpost'`
// on `social_publisher_orgs` so that swap is not even a migration.
//
// ── THE CONTAINMENT RULES, RESTATED WHERE THEY ARE ENFORCED ─────────────────────────────────────
//   1. NO Postiz package, type, schema or code is imported anywhere under this directory. The
//      adapter speaks HTTP+JSON against Postiz's public REST API only. This is mechanically
//      enforced, not merely asserted: `npm run lint:postiz-deps` fails the build on a `postiz`
//      dependency in package.json OR any import/require of a postiz-ish module in src/, and
//      containment.test.ts re-asserts it inside the test suite so it also fails locally.
//   2. Drivers are STATELESS PER CALL. No connection object, no cached session, no in-memory org
//      state. The org-scoped API key is resolved from `social_publisher_orgs.api_key_ref` AT CALL
//      TIME (see OrgHandle below) and is never stored on the driver instance — a process-level
//      singleton holding a tenant's credential is how one tenant's key serves another's call.
//   3. Every call is OTel-annotated with `social.network` / `social.org` / `social.op` /
//      `social.cost_usd` (design §05 driver rules). The org id is an OPAQUE upstream identifier and
//      is safe to put on a span; the API key never is, and `OrgHandle` is built so an accidental
//      log/serialize cannot emit it (see its `toJSON`/inspect hooks).
//   4. Tenancy lives in OUR schema (D-2). The driver never learns a tenant id, a client id, an
//      engagement or a user. It receives an opaque org id and content that a human already
//      approved. That is what keeps "multi-tenancy outside the licence zone" a structural property
//      rather than a promise.
//
// ── WHAT THE SMM-04 SPIKE MADE OBSOLETE IN DESIGN §05 (read before "restoring" a method) ────────
// The §05 sketch was written in 2026-07-23, before the engine was measured. Three of its members
// did not survive contact with the product, and the shape below is the corrected one:
//
//   (a) `listComments` / `sendReply` are **OPTIONAL** here, not required members. Postiz has ZERO
//       inbound engagement surface — no comments, no DMs, for ANY network. Not "unexposed over
//       REST": the capability does not exist in the product (spike §8b, addendum §A4j finding 2,
//       verified from its live OpenAPI's 22 `/public/v1` routes and its provider sources; the
//       `GET /public/posts/{id}/comments` route is a DECOY — Prisma's `Comments` model is internal
//       team notes on a draft). A required member would have forced the driver to ship a method
//       that throws, which reads as a bug; an optional one makes the gap a CAPABILITY FACT the
//       registry can mirror and the console can explain. P2 (SMM-15/16/17/18) has nothing to call
//       behind this port and is the architect's to re-plan.
//   (b) `createOrg` is **capability-gated and unimplemented by the Postiz driver.** There is no
//       public REST route that creates an organization. The only way to make one is the runbook's
//       bootstrap ceremony: flip `SOCIAL_POSTIZ_DISABLE_REGISTRATION=false`, `POST /api/auth/register`
//       exactly once, flip it back, and verify the door is shut (deploy-vps.md §"Bootstrap, in
//       order" step 6). That ceremony is a human, audited act on the licence-zone host — it is NOT
//       something this platform should be able to trigger over HTTP, and building a driver method
//       for it would have meant either forking Postiz or handing the ERP the registration door.
//       So provisioning ADOPTS an operator-created org: `verifyOrg` proves the (org id, key) pair
//       answers, and our row is the mapping. `createOrg` stays on the port because a driver that
//       CAN create orgs (Mixpost) should not need an interface change to say so.
//   (c) `getPostStatus`'s "authoritative re-fetch" is a BATCHED, DATE-RANGED read, not a per-id
//       loop. `GET /public/v1/posts` takes a range (addendum §A4l §4), and the reconcile sweep now
//       crosses a host boundary — one call per (org, window) amortises the hop to nothing and keeps
//       the 15-minute cadence a freshness decision instead of a cost decision.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────
// It does not publish. `schedulePost` exists for SMM-09 to call from behind the D14 executable-
// approval gate; SMM-05 wires no approval path, no `social.publishPost` tool and no publish
// endpoint. The one thing this port DOES enforce about publishing is structural and cheap: a
// dispatch with no `approvalId` is refused by the driver itself (`approval_required`), so a future
// caller cannot reach a live network by simply forgetting the gate.
import type { Network, QuotaSnapshot } from "../media-rules";

export type PublisherKey = "postiz" | "mixpost";

/** What a driver can do AT ALL. A capability the driver does not advertise is refused fail-closed
 *  with `capability_unsupported` — never silently no-op'd, and never faked with an empty result.
 *  (Agentic bar: "explicit refusal — never fold a denial into an empty list". An empty comment list
 *  and "this engine cannot read comments" are different facts and must stay different answers.) */
export type PublisherCapability =
  | "org_create"      // can mint an org over its API (Postiz: NO — see the header, item (b))
  | "org_verify"      // can prove an (org, key) pair is live
  | "connect_url"     // can start a network OAuth flow
  | "integrations"    // can list an org's connected accounts — the registry-sync source
  | "quota_probe"     // can read a network's LIVE posting quota for one account (§A4f)
  | "schedule"        // can queue an approved post
  | "cancel"          // can cancel a queued, not-yet-published post
  | "post_status"     // can re-fetch authoritative post state
  | "account_metrics"
  | "post_metrics"
  | "media_upload"
  | "inbox_read"      // Postiz: NO, for every network (spike §8b)
  | "inbox_reply";    // Postiz: NO, for every network (spike §8b)

// ── The org handle: custody split (b), made hard to leak ─────────────────────────────────────────
//
// D-5's three-way split puts the Postiz ORG API KEY server-side, resolved by alias at call time,
// and forbids it from reaching platform-ui, n8n credentials, a tenant row, an audit line or a log
// field. Two of those are enforced by where the value is read (config/env, never a column); the
// LOG one is enforced here, because "never log the key" is the kind of rule that holds until
// someone debugs a failing call with `JSON.stringify(org)`.
//
// So the handle is a class, not a bag: the key is reachable only through `secret()`, and BOTH
// serialization paths a Node process uses to render an object incidentally — `JSON.stringify` and
// `util.inspect` (which is what pino, console.log and a Vitest diff all end up calling) — are
// overridden to emit `[redacted]`. publisher.test.ts pins both.
export class OrgHandle {
  constructor(
    /** `social_publisher_orgs.id` — OUR row. Carried so a span/audit line can name the mapping. */
    readonly publisherOrgId: string,
    /** The opaque upstream org id. Safe on a span; it identifies a mapping, not a credential. */
    readonly orgId: string,
    private readonly key: string,
  ) {}

  /** The org-scoped API key (custody split (b)). Call site: the Authorization header, and nowhere
   *  else. Never assign the result to a variable that outlives the request. */
  secret(): string {
    return this.key;
  }

  toJSON(): Record<string, string> {
    return { publisherOrgId: this.publisherOrgId, orgId: this.orgId, apiKey: "[redacted]" };
  }

  toString(): string {
    return `OrgHandle(${this.orgId})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `OrgHandle(${this.orgId}) { apiKey: [redacted] }`;
  }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────────────────────────

/** One connected account as the ENGINE sees it — the registry-sync source. Deliberately small:
 *  every field here is state ABOUT a connection. There is no token field and there must never be
 *  one (D-5 custody split (c): network tokens are minted, refreshed and held inside the licence
 *  zone and are never copied into our DB, our vault or our logs). */
export interface IntegrationState {
  /** Opaque upstream integration id → `social_accounts.postiz_integration_id`. */
  id: string;
  /** The network. A driver reporting one we do not model is SKIPPED by the sync with a named
   *  warning, never coerced — 0105's CHECK constraint would reject it anyway, and a coerced
   *  network would mis-route a publish. */
  network: string;
  /** The account handle/username as the network reports it → `social_accounts.handle`. */
  handle: string;
  displayName?: string;
  /** The engine's own view of connection health. Mapped onto 0105's status vocabulary by
   *  `deriveAccountStatus` (capabilities.ts) — never written through raw. */
  disabled?: boolean;
  /** The engine says the token needs a human to re-consent (LinkedIn's annual re-consent, Meta's
   *  60-day, TikTok's 24h access token: §A4e/§A4f/§A4h all make this a first-class state). */
  refreshNeeded?: boolean;
  /** Free-text error the engine last saw on this connection → `social_accounts.last_error`. */
  error?: string;
  /** The network's own account id, when the engine surfaces it. Needed for the Instagram live
   *  quota probe (`GET /<IG_ID>/content_publishing_limit`, §A4f). Absent ⇒ no probe, quota unknown. */
  networkAccountId?: string;
}

export interface OrgVerification {
  ok: boolean;
  /** Number of integrations the org reports. 0 is a perfectly valid verified org (a freshly
   *  created one) — this is a fact, not a health signal. */
  integrationCount: number;
}

/** The unit `schedulePost` dispatches. Assembled by the caller (SMM-09) from an APPROVED variant;
 *  the driver's only job is to speak the engine's dialect. */
export interface VariantDispatch {
  /** Opaque upstream integration id of the target account. The caller resolved it through the
   *  FK chain (`assertDispatchChain`) — the driver does no tenancy reasoning of its own. */
  integrationId: string;
  network: Network;
  body: string;
  firstComment?: string | null;
  /** Already-uploaded media references (see `uploadMedia`). */
  media?: Array<{ id: string; url?: string }>;
  /** Per-network settings, already translated into the engine's dialect by the caller. TikTok's
   *  polarity inversions and renames (`comment` → `disable_comment`, `video_made_with_ai` →
   *  `is_aigc`) are the caller's translation, documented in spike §8a — NOT this driver's, because
   *  the composer is what must show the creator what it is sending. */
  settings?: Record<string, unknown>;
  scheduledAt?: string | null;
  /** THE ONE-SHOT APPROVAL (D-6). The driver refuses `approval_required` without it. It is never
   *  sent to the engine — it is our own gate's token, and the licence zone has no business seeing
   *  an approval id. The check exists so a caller that forgets the gate cannot reach a network. */
  approvalId: string;
  /** Our variant id, for idempotency + correlation. Also never sent upstream. */
  variantId: string;
}

export interface PostStatus {
  providerPostId: string;
  state: "queued" | "publishing" | "published" | "failed" | "cancelled" | "unknown";
  publishedUrl?: string;
  publishedAt?: string;
  error?: string;
}

export interface DailyMetrics {
  date: string; // YYYY-MM-DD
  followers?: number;
  impressions?: number;
  reach?: number;
  engagements?: number;
  linkClicks?: number;
  videoViews?: number;
  raw?: Record<string, unknown>;
}

export interface PostMetrics {
  providerPostId: string;
  impressions?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  videoViews?: number;
  clicks?: number;
}

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string;
}

/** What `estimateCostUsd` prices. X is the only metered network in v1 (~$0.015/post, ~$0.20 with a
 *  link — design §05/OQ-2, re-verify at build time); everything else is $0 through Postiz. The
 *  method is PURE and SYNCHRONOUS on purpose: the stop-loss and the composer's price-before-approval
 *  card both call it, and neither may make a network call to learn a price. */
export interface PublishOp {
  network: Network;
  items?: number;
  /** X prices a post with a link differently. */
  hasLink?: boolean;
}

export interface InboxItem {
  externalId: string;
  externalThreadId: string;
  kind: "comment" | "dm" | "mention" | "review";
  authorHandle?: string;
  authorName?: string;
  body: string;
  postedAt: string;
}

export interface ReplyDispatch {
  integrationId: string;
  externalThreadId: string;
  body: string;
  approvalId: string;
}

// ── The port ────────────────────────────────────────────────────────────────────────────────────

export interface SocialPublisher {
  key: PublisherKey;
  capabilities: ReadonlySet<PublisherCapability>;

  // Org lifecycle. The tenant mapping stays OURS; the driver only ever carries the opaque org ref.
  /** Mint an org. `capability_unsupported` on Postiz — see the file header, item (b). */
  createOrg(ref: { name: string }): Promise<{ orgId: string; apiKeyRef: string }>;
  /** Prove an (org id, resolved key) pair is live. Cheapest authenticated read the engine has. */
  verifyOrg(org: OrgHandle): Promise<OrgVerification>;
  /** OAuth entry point for binding a client's real account. SMM-07 owns the ceremony around it. */
  connectUrl(org: OrgHandle, network: Network, redirect: string): Promise<string>;
  /** The connector-registry sync source. */
  listIntegrations(org: OrgHandle): Promise<IntegrationState[]>;

  /** LIVE per-account quota. Returns `undefined` when this account's network has no quota endpoint,
   *  or when the engine cannot carry the probe — which is a real, expected outcome and NOT an
   *  error. `undefined` becomes `quota: {}` in the registry, and `media-rules.checkQuota` already
   *  treats an absent counter as `quota_unknown` (a warning), never as "zero used".
   *
   *  ⚠ A DRIVER MUST NEVER SYNTHESIZE A CAP HERE. Addendum §A4f: the "IG ~25 posts/24h" figure the
   *  design carried since 2026-07-23 is obsolete, Meta's current doc says 100 and — on the same
   *  page — 50, and 25 appears nowhere in it. We ask the account what its own limit is
   *  (`GET /<IG_ID>/content_publishing_limit`) or we record that we do not know. A constant here
   *  would be wrong in a way nothing downstream could detect. */
  getQuota(org: OrgHandle, integration: IntegrationState): Promise<QuotaSnapshot | undefined>;

  // Publishing. Accepts ONLY approved work: the CALLER enforces §07/D-6, and the driver asserts the
  // approvalId is present so a caller that skipped the gate cannot reach a network by accident.
  schedulePost(org: OrgHandle, req: VariantDispatch): Promise<{ providerPostId: string }>;
  cancelPost(org: OrgHandle, providerPostId: string): Promise<void>;
  /** Authoritative re-fetch, BATCHED over a window (see header item (c)). */
  getPostStatus(org: OrgHandle, providerPostIds: string[], range?: DateRange): Promise<PostStatus[]>;

  /** Upload media into the engine before a dispatch references it. The ONE call on this hop whose
   *  duration changed by more than milliseconds when Postiz moved hosts (§A4l §4) — hence its own
   *  timeout class, and the MTU trap in the runbook that silently black-holes exactly this traffic. */
  uploadMedia(org: OrgHandle, file: { filename: string; contentType: string; bytes: Uint8Array }): Promise<{ id: string; url?: string }>;

  // Analytics.
  getAccountMetrics(org: OrgHandle, integrationId: string, range: DateRange): Promise<DailyMetrics[]>;
  getPostMetrics(org: OrgHandle, providerPostIds: string[]): Promise<PostMetrics[]>;

  // Engagement surface — OPTIONAL, and the absence IS the finding (header item (a)). A driver that
  // cannot read an inbox simply does not implement these; callers must check `capabilities` and
  // refuse `capability_unsupported` rather than calling a phantom default.
  listComments?(org: OrgHandle, integrationId: string, since: Date): Promise<InboxItem[]>;
  sendReply?(org: OrgHandle, req: ReplyDispatch): Promise<{ externalId: string }>;

  /** Consulted BEFORE dispatch. Pure + synchronous (see PublishOp). */
  estimateCostUsd(op: PublishOp): number;
}

// ── Typed refusals ──────────────────────────────────────────────────────────────────────────────
//
// All fail-closed, all `code`-discriminated so an agent can branch without string-matching prose
// (agentic bar criterion 2). Mapped onto HTTP by publisher-error.filter.ts, which — like its
// search-module sibling — builds the body itself, so the `message`-vs-`error` trap in
// src/http-error.filter.ts does not apply to these (that trap is specific to HttpException
// payloads, where Nest replaces a token passed as `error`).
export type PublisherRefusalCode =
  /** No driver registered — SOCIAL_POSTIZ_BASE_URL unset. The module still serves every read. */
  | "publisher_not_configured"
  /** Registered, but the engine did not answer (tunnel down, host down, timeout). Loud, not silent. */
  | "publisher_unreachable"
  /** The engine answered with a non-2xx. Its status is carried; its BODY is not re-thrown verbatim. */
  | "publisher_http_error"
  /** This driver can never do this. A different driver is required — not a retry. */
  | "capability_unsupported"
  /** `api_key_ref` names an alias this deployment has no key for. A misconfiguration, refused loudly
   *  rather than attempted unauthenticated. */
  | "org_key_unresolved"
  /** No `social_publisher_orgs` row for this (tenant, client). */
  | "org_not_provisioned"
  /** The upstream org id is already mapped to a DIFFERENT client — 0105's `UNIQUE (postiz_org_id)`,
   *  surfaced as a decision instead of a 500. */
  | "org_conflict"
  /** THE WRONG-ACCOUNT-PUBLISH DEFENCE. The account does not belong to the variant's engagement's
   *  client. Refused fail-closed with an audit line. */
  | "cross_client_account"
  /** The target account is not in a state that can publish. */
  | "account_not_connected"
  /** The network is off at the DEPLOYMENT level (config), which outranks any engagement scope. */
  | "network_disabled"
  /** A dispatch arrived with no one-shot approval id (D-6). Structural, not advisory. */
  | "approval_required"
  /** A driver key that is not registered. */
  | "unknown_publisher";

export class SocialPublisherError extends Error {
  constructor(
    readonly code: PublisherRefusalCode,
    message: string,
    /** Upstream HTTP status, when there was one. Never the upstream body — an engine error string
     *  can carry content we have no reason to re-emit into our own surfaces. */
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "SocialPublisherError";
  }
}
