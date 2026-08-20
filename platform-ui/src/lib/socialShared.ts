// Social-media (SMM) pure types + constants — split out of `lib/social.ts` for the EXACT reason
// `searchMarketingShared.ts`'s own header states: `lib/social.ts` imports `lib/platform.ts`
// (`"server-only"`), so a CLIENT component (e.g. `components/social/ValidationList.tsx`, rendered
// from inside a "use client" variant editor) that needs even a single VALUE export from there —
// not just a type — fails the Next.js build with "You're importing a component that needs
// server-only". `QUOTA_UNKNOWN_RULE`/`IMAGE_GENERATION_UNAVAILABLE_WARNING`/`SOCIAL_NETWORKS` are
// real runtime values, not erased types, so they live here. Server code keeps importing from
// `lib/social.ts` (which re-exports everything here); client code importing only TYPES could import
// from either file safely, but importing from here is the unambiguous, always-safe choice.
export type SocialNetwork =
  | "instagram" | "facebook" | "tiktok" | "linkedin" | "x"
  | "youtube" | "threads" | "pinterest" | "bluesky" | "mastodon";

export const SOCIAL_NETWORKS: readonly SocialNetwork[] = [
  "instagram", "facebook", "tiktok", "linkedin", "x",
  "youtube", "threads", "pinterest", "bluesky", "mastodon",
];

/** The tool-scope dial (design §04/§09; addendum D-14/D-17). Always fully populated on read — the
 *  backend merges defaults UNDER the stored value one level deep (`mergeScope`), so every known
 *  group/key is present even for an engagement created before a toggle existed. `[k: string]:
 *  unknown` at the top level tolerates a future group this client does not know about yet, rather
 *  than dropping it silently. */
export interface ToolScope {
  networks: Record<SocialNetwork, boolean>;
  posting: { cadencePerWeek: number; requiresClientOk: boolean };
  inbox: { enabled: boolean; slaMinutes: number; dm: boolean };
  ai: { drafting: boolean; cloudPolish: boolean; imageGen: boolean };
  reporting: { cadence: string };
  [k: string]: unknown;
}

export const EMPTY_TOOL_SCOPE: ToolScope = {
  networks: {
    instagram: false, facebook: false, tiktok: false, linkedin: false, x: false,
    youtube: false, threads: false, pinterest: false, bluesky: false, mastodon: false,
  },
  posting: { cadencePerWeek: 3, requiresClientOk: false },
  inbox: { enabled: false, slaMinutes: 240, dm: false },
  ai: { drafting: true, cloudPolish: false, imageGen: false },
  reporting: { cadence: "monthly" },
};

export interface SocialEngagement {
  id: string;
  clientId: string;
  projectId: string | null;
  name: string;
  status: "draft" | "active" | "paused" | "closed";
  usageBudgetUsd: number;
  ownerId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** `getEngagement` — the list row's fields plus the joined brand-voice profile (tone/hashtag
 *  strategy/knowledge pointers) and `toolScope` itself. `tone`/`hashtagStrategy`/
 *  `knowledgeSourceIds` are `undefined` when the client has no brand profile row yet (LEFT JOIN). */
export interface SocialEngagementDetail extends Omit<SocialEngagement, "customFields"> {
  toolScope: ToolScope;
  customFields: Record<string, unknown>;
  tone?: Record<string, unknown>;
  hashtagStrategy?: Record<string, unknown>;
  knowledgeSourceIds?: string[];
}

export interface EngagementScope {
  toolScope: ToolScope;
  usageBudgetUsd: number;
}

/** See `lib/social.ts`'s header, discrepancy #1 — `usageBudgetUsd` on THIS response is not
 *  trustworthy as "the persisted budget" unless the caller's patch actually included one. */
export interface ScopePatchResult {
  toolScope: ToolScope;
  usageBudgetUsd: number | undefined;
  warnings: string[];
}

export interface SocialBrandProfile {
  id: string;
  clientId: string;
  tone: Record<string, unknown>;
  hashtagStrategy: Record<string, unknown>;
  knowledgeSourceIds: string[];
  updatedAt: string;
}

export interface SocialCampaign {
  id: string;
  engagementId: string;
  name: string;
  kind: "organic"; // 'paid' is a reserved schema seam, never returned/settable in v1
  goal: string | null;
  status: string;
  customFields: Record<string, unknown>;
  createdAt: string;
}

export interface SocialKpiTarget {
  id: string;
  engagementId: string;
  metricKey: string;
  baselineValue: number | null;
  targetValue: number;
  direction: "up" | "down";
  duePeriod: string | null;
}

export type SocialPostStatus =
  | "idea" | "draft" | "in_review" | "approved" | "scheduled" | "publishing"
  | "published" | "partially_published" | "failed" | "archived";

/** The roll-up shape `GET posts` returns per variant — enough to render the calendar without an
 *  N+1 read (status, schedule, published URL, metered cost; NOT the full body/media/settings, and
 *  NOT network/handle — those are only joined on `getPost`'s detail read; see `lib/social.ts`'s
 *  header on this exact gap). */
export interface SocialPostVariantSummary {
  id: string;
  accountId: string;
  status: string;
  scheduledAt: string | null;
  publishedUrl: string | null;
  nativeImport: boolean;
  estimatedCostUsd: number;
}

export interface SocialPost {
  id: string;
  engagementId: string;
  campaignId: string | null;
  title: string;
  brief: string | null;
  source: "human" | "ai" | "agent" | "native_import";
  status: SocialPostStatus;
  scheduledAt: string | null;
  createdBy: string;
  createdAt: string;
  variants: SocialPostVariantSummary[];
}

export interface ValidationIssue {
  /** snake_case TOKEN — the contract. Render/branch against THIS, never against `message` prose
   *  (docs/FRONTEND-BFF-CONTRACT.md §19's own binding rule). */
  rule: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** `quota_unknown` is a WARNING token, never a pass — an absent registry sync is not "zero posts
 *  used." Named here so callers branch on the token, not on a guessed string. */
export const QUOTA_UNKNOWN_RULE = "quota_unknown";
/** The scope-patch warning naming the AI image-gen toggle's inert state (addendum D-17) — no
 *  generative-image backend exists in the estate. Composer v1 is attach-only and never triggers
 *  this path itself, but the token is exported so any surface reading `ScopePatchResult.warnings`
 *  can recognise it without string-matching prose. */
export const IMAGE_GENERATION_UNAVAILABLE_WARNING = "image_generation_unavailable";

/** One attached-media descriptor — `social_post_variants.media` (D-15: deliberately OUTSIDE
 *  `uploaded_media`, see `dispatch.ts`'s header). `format` (SMM-37/SMM-20) is optional and
 *  composer/library-supplied, never re-derived from `files.content_type` on THIS side of the
 *  wire — same trust boundary `media-rules.ts`'s own `MediaItem.format` doc states. */
export interface MediaDescriptor {
  fileId?: string;
  kind?: "image" | "video";
  alt?: string;
  format?: string;
}

/** Full per-network variant content (`getPost`'s `variants[]` and every variant write response). */
export interface SocialPostVariant {
  id: string;
  accountId: string;
  network: SocialNetwork;
  handle: string;
  body: string;
  firstComment: string | null;
  media: MediaDescriptor[];
  settings: Record<string, unknown>;
  validation: ValidationResult;
  argsSha256: string;
  approvalId: string | null;
  nativeImport: boolean;
  scheduledAt: string | null;
  status: string;
  publishedUrl: string | null;
  publishedAt: string | null;
  lastError: string | null;
  estimatedCostUsd: number;
}

export interface SocialPostDetail {
  id: string;
  engagementId: string;
  campaignId: string | null;
  title: string;
  brief: string | null;
  source: SocialPost["source"];
  status: SocialPostStatus;
  scheduledAt: string | null;
  customFields: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  variants: SocialPostVariant[];
}

export interface CreateVariantResult {
  id: string;
  created: boolean;
  validation: ValidationResult;
  argsSha256: string;
  estimatedCostUsd: number;
}

export interface UpdateVariantResult {
  ok: true;
  validation: ValidationResult;
  argsSha256: string;
  /** Told out loud the moment an edit drops an approved/in-review variant back to `draft` — a
   *  console must surface this immediately, never let the operator discover it on the next load. */
  approvalInvalidated: boolean;
}

export interface VariantValidationResult {
  validation: ValidationResult;
  estimatedCostUsd: number;
  network: SocialNetwork;
}

export interface CreatedResult {
  id: string;
  created: boolean;
}

// ── accounts (SMM-05 registry read, first consumed here by SMM-12) ────────────────────────────────
//
// `GET .../accounts` (social.controller.ts's `listAccounts`) IS live — corrects `lib/social.ts`'s
// own header, written during SMM-11 before SMM-05 shipped this route. `quota` is a LIVE PROBE
// result and is `{}` (or missing a network's bucket) whenever the registry hasn't synced — there is
// no quota constant anywhere in this module (media-rules.ts's own header) and this type must not
// grow one. `capabilities` is the AND of what the network's API can ever do and what the registered
// driver can reach (`publisher/capabilities.ts`'s `AccountCapabilities`) — three different reasons a
// capability is `false` ("network" permanent, "driver" fixable, "unverified" nobody researched it
// yet), named per-key in `unsupported` rather than collapsed into one grey control.
export type QuotaUnsupportedReason = "network" | "driver" | "unverified";

export interface AccountCapabilities {
  schedule: boolean;
  nativeSchedule: boolean;
  directPost: boolean;
  stories: boolean;
  comments: boolean;
  dm: boolean;
  analytics: boolean;
  unsupported: Partial<Record<
    "schedule" | "nativeSchedule" | "directPost" | "stories" | "comments" | "dm" | "analytics",
    QuotaUnsupportedReason
  >>;
}

/** Mirrors `media-rules.ts`'s `QuotaSnapshot` — a live probe result, `{}` when unavailable. `[k:
 *  string]: unknown` tolerates a bucket this client doesn't know the shape of yet, same reasoning
 *  as `ToolScope`'s index signature. */
export interface AccountQuota {
  igPosts24h?: { used: number; cap: number };
  youtubeQuota?: {
    searchListCallsToday?: { used: number; cap: number };
    videosInsertCallsToday?: { used: number; cap: number };
    otherUnitsToday?: { used: number; cap: number };
  };
  [k: string]: unknown;
}

export interface SocialAccount {
  id: string;
  clientId: string;
  network: SocialNetwork;
  handle: string;
  displayName: string | null;
  status: "connected" | "expiring" | "expired" | "error";
  quota: AccountQuota;
  capabilities: AccountCapabilities;
  lastError: string | null;
  healthCheckedAt: string | null;
  connectedAt: string | null;
  publisherOrgRef: string;
  driver: string;
}

// ── the publish gate's dry-run verdict (SMM-09/SMM-12) ─────────────────────────────────────────────
//
// Mirrors `publish-precondition.ts`'s `PublishPreconditionStage`/`PUBLISH_PRECONDITION_STAGES`
// exactly (six stages, this order) — pinned here as a client-safe copy rather than imported, since
// this file must stay importable from a client component. `socialShared.test.ts` asserts the order
// so a reorder on the backend side is caught rather than silently drifting.
export const PUBLISH_PRECONDITION_STAGES = ["scope", "quota", "hash", "unconsumed", "budget", "creator_info"] as const;
export type PublishPreconditionStage = (typeof PUBLISH_PRECONDITION_STAGES)[number];

/** `GET .../variants/:variantId/publish-preconditions` — a DRY RUN, returned as DATA with a 200.
 *  `ok: false` names the exact stage and token that stopped it; never render this as an empty list
 *  or a generic failure (criterion 5).
 *
 *  `stage` is widened to include `"client_review"` (SMM-31/D-16): `evaluatePublishPreconditionWithClientReview`
 *  composes the client-review gate IN FRONT of the six pinned stages, never as a 7th entry in
 *  `PUBLISH_PRECONDITION_STAGES` (that array stays exactly six, verbatim, per the backend's own
 *  pinned contract test) — but the dry-run response's `stage` field can genuinely read
 *  `"client_review"` when a variant's engagement requires client sign-off and it hasn't cleared. A
 *  console must render that stage/reason pair exactly like any of the six, not treat it as an
 *  unrecognised value. */
export interface PublishPreconditionResult {
  ok: boolean;
  stage?: PublishPreconditionStage | "client_review";
  reason?: string;
  stages: readonly PublishPreconditionStage[];
  tool: string;
  meteredTool: string;
}

// ── the client-review stage (SMM-31/SMM-32, D-16) ──────────────────────────────────────────────────
//
// Mirrors `platform-nest/src/modules/social/client-review.ts`'s `CLIENT_REVIEW_REFUSAL` verbatim —
// pinned here by hand rather than imported, same reasoning `PUBLISH_PRECONDITION_STAGES`'s own copy
// gives (`platform-ui`/`platform-nest` are separate projects, no shared package layer). Every one of
// these five tokens must render as ITSELF (criterion 5) — see `REFUSAL_LABELS` below and
// `socialShared.test.ts`'s "names every client-review refusal token" case.
export const CLIENT_REVIEW_REFUSAL = {
  clientReviewNotRequested: "client_review_not_requested",
  clientReviewPending: "client_review_pending",
  clientReviewChangesRequested: "client_review_changes_requested",
  clientReviewWithdrawn: "client_review_withdrawn",
  clientReviewStale: "client_review_stale",
} as const;
export type ClientReviewRefusalReason = (typeof CLIENT_REVIEW_REFUSAL)[keyof typeof CLIENT_REVIEW_REFUSAL];

/** `GET variants/:variantId/client-review`'s exact response shape (social.controller.ts). A variant
 *  that never had a review asked reads `{status:'not_requested'}` — data, not a 404 (a legitimate
 *  steady state, same doctrine `PublishPreconditionResult` follows for a passing dry run). */
export type ClientReviewStatus = "not_requested" | "pending" | "approved" | "changes_requested" | "withdrawn";
export interface ClientReviewState {
  status: ClientReviewStatus;
  id?: string;
  comment?: string | null;
  reviewedArgsSha256?: string | null;
  requestedAt?: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
}
export const NOT_REQUESTED_REVIEW: ClientReviewState = { status: "not_requested" };

export type ClientReviewVerdict = { ok: true } | { ok: false; reason: ClientReviewRefusalReason };

// ── the asset library (SMM-20, AMENDED by D-17 — attach only, generation removed) ─────────────────
//
// `GET engagements/:id/asset-library` — files already on record for the engagement's CLIENT
// (uploads AND Drive-mirrored references, `source` names which) plus every Studio-graded
// `creative_assets` row in the tenant. Neither source is a `social_*` table (see
// `social.controller.ts`'s own module-GUC boundary note for this endpoint) — this is read-only
// browsing data, never itself hashed or approved; only the DESCRIPTOR an attach produces touches
// `args_sha256`.
export interface AssetLibraryFile {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  /** `upload` = real bytes in our storage; `drive` = a reference-attach with a `url` and no blob
   *  of ours (OQ-5's "files + Drive mirror" — a Drive-origin attachment rides the SAME `files`
   *  row shape, distinguished only by the absent `storage_key`). Render these distinctly; never
   *  claim a `drive` row has bytes it doesn't. */
  source: "upload" | "drive";
  url: string | null;
  createdAt: string;
}

export interface AssetLibraryStudioAsset {
  id: string;
  name: string;
  contentType: string;
  width: number | null;
  height: number | null;
  gradedByteSize: number;
  presetId: string | null;
  createdAt: string;
}

export interface AssetLibrary {
  files: AssetLibraryFile[];
  studioAssets: AssetLibraryStudioAsset[];
}

export const EMPTY_ASSET_LIBRARY: AssetLibrary = { files: [], studioAssets: [] };

/** `POST variants/:id/media/attach` — the ONLY write this ticket adds. Mirrors
 *  `UpdateVariantResult` (same edit-invalidates-approval contract) plus the resolved `fileId` and
 *  the variant's full `media` array as it now stands, so the caller can render the new entry
 *  without a second round trip. */
export interface AttachMediaResult {
  ok: true;
  fileId: string;
  media: MediaDescriptor[];
  validation: ValidationResult;
  argsSha256: string;
  approvalInvalidated: boolean;
}

/** A client-safe MIRROR of the backend's `evaluateClientReviewPrecondition` (client-review.ts) — same
 *  five-way branch, same "approved-but-`reviewedArgsSha256` no longer matches the LIVE `argsSha256`
 *  is `stale`" rule (D-15 restated for the client's side). Used by the Composer's per-variant panel
 *  to decide which of the five tokens — or a genuine pass — to render. The calendar's rollup lacks
 *  `argsSha256` (see `CalendarGrid.tsx`'s own comment on that gap), so it renders the raw `status`
 *  only and never claims staleness. Never re-derives "not requested"/"pending"/etc. from scratch; it
 *  only adds the ONE thing the raw status alone cannot answer (staleness), which needs the variant's
 *  live hash as an input the review response itself does not carry. */
export function evaluateClientReviewState(review: ClientReviewState, liveArgsSha256: string): ClientReviewVerdict {
  switch (review.status) {
    case "not_requested":
      return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewNotRequested };
    case "pending":
      return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewPending };
    case "withdrawn":
      return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewWithdrawn };
    case "changes_requested":
      return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewChangesRequested };
    case "approved":
      return review.reviewedArgsSha256 === liveArgsSha256
        ? { ok: true }
        : { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewStale };
    default:
      return { ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewNotRequested };
  }
}

// ── quota strips ────────────────────────────────────────────────────────────────────────────────
//
// A pure display-side mirror of `media-rules.ts`'s `checkQuota` bucket selection: for a network
// that has a MODELED live counter, read that exact bucket (never a sibling one — the YouTube
// header's own lesson is that reading `otherUnitsToday` where `videosInsertCallsToday` is meant
// reports headroom in the wrong 10,000-unit pool while the bucket that actually gates an upload is
// exhausted). For every other network there is no counter modeled at all — that is NOT the same
// fact as "unsynced": the account never got measured because nobody has ever wired up a probe.
// `describeQuota` says that as its own status rather than folding it into "unknown".
export type QuotaStripStatus = "known" | "unknown" | "not_modeled";

export interface QuotaStripInfo {
  status: QuotaStripStatus;
  /** Human label, always safe to render standalone. */
  label: string;
  used?: number;
  cap?: number;
}

export function describeQuota(network: SocialNetwork, quota: AccountQuota | undefined): QuotaStripInfo {
  if (network === "instagram") {
    const q = quota?.igPosts24h;
    if (q && typeof q.used === "number" && typeof q.cap === "number") {
      return { status: "known", label: `${q.used}/${q.cap} posts used (24h)`, used: q.used, cap: q.cap };
    }
    return { status: "unknown", label: "Unknown — registry not synced (never zero)" };
  }
  if (network === "youtube") {
    const q = quota?.youtubeQuota?.videosInsertCallsToday;
    if (q && typeof q.used === "number" && typeof q.cap === "number") {
      return { status: "known", label: `${q.used}/${q.cap} uploads used today`, used: q.used, cap: q.cap };
    }
    return { status: "unknown", label: "Unknown — registry not synced (never zero)" };
  }
  return { status: "not_modeled", label: "Not tracked — no live quota probe is modeled for this network" };
}

/** True only on a genuine Cerbos 403. Never true for a 404 (module dark / entity absent) — see
 *  `lib/social.ts`'s header for the full "403 must never fold into an empty state" rule this
 *  shape exists to carry. */
export interface Guarded<T> {
  data: T;
  forbidden: boolean;
}

// ── refusal-token labels (docs/FRONTEND-BFF-CONTRACT.md §19: "the token IS the contract... render
// against the token, never by matching prose"). Every entry below is keyed on the EXACT token the
// controller's `refuse()` throws; `describeRefusal` falls back to the raw token (still the
// contract, just unstyled) for anything not yet named here rather than inventing prose for an
// unknown one. ─────────────────────────────────────────────────────────────────────────────────
const REFUSAL_LABELS: Record<string, string> = {
  missing_field: "A required field is missing.",
  invalid_id: "That id isn't a valid uuid.",
  invalid_status: "That isn't a recognised status.",
  invalid_source: "Source must be human, ai, or agent.",
  no_fields: "Nothing was changed — no fields were sent.",
  unknown_network: "That account's network isn't recognised.",
  invalid_scope: "That scope patch isn't a valid object.",
  invalid_scope_value: "That scope value isn't valid.",
  invalid_budget: "Budget must be a non-negative number.",
  invalid_direction: "Direction must be up or down.",
  post_has_live_variants: "This post has variants that are queued, publishing, or already published — it can't be deleted while any of them are live.",
  variant_not_editable: "This variant is no longer editable (it's live, in flight, or already published).",
  variant_native_import_immutable: "This variant records a post published by hand — it can't be edited, only viewed.",
  variant_is_live: "This variant is queued, publishing, or already published — it can't be deleted.",

  // ── SMM-20 (asset attach; AMENDED by D-17 — generation removed) ───────────────────────────────
  unsupported_asset_source: "That isn't a recognised asset source (must be a file or a Studio asset).",
  asset_not_found: "That asset no longer exists (deleted, or never did) — try refreshing the library.",

  // ── the publish-precondition vocabulary (platform-nest's `PUBLISH_REFUSAL`, publish-
  // precondition.ts) — the dry-run endpoint `GET .../publish-preconditions` and the D14 executor
  // report the SAME sixteen tokens, in the SAME six stages (scope → quota → hash → unconsumed →
  // budget → creator_info). Every token that file defines gets its own sentence here — none of
  // them may collapse into a generic "something went wrong" (criterion 5 of the agentic bar).
  variant_not_found: "That variant no longer exists (deleted, or never did).",
  cross_client_account: "The target account belongs to a different client than this post's engagement — a cross-client publish is refused outright.",
  account_not_connected: "The destination account is not in a connected state right now.",
  network_disabled: "This network is switched off for the whole deployment, above any per-engagement setting.",
  network_not_in_scope: "This engagement's tool scope does not allow posting to this network.",
  engagement_inactive: "The engagement is paused, closed, or still a draft — not active — so nothing can publish under it.",
  metered_network_requires_metered_tool: "This is a metered network and must go through the metered publish path, not the free one.",
  quota_exhausted: "This account's live posting quota is used up right now.",
  media_rules_failed: "The content no longer passes this network's media/body/schedule rules (something changed since it was approved).",
  args_hash_mismatch: "The content has changed since this was approved — the approval no longer matches what's here now.",
  already_dispatched: "This already went out (or is in flight) — publishing again would post it a second time.",
  approval_already_consumed: "An approval was already spent on this variant.",
  variant_not_approved: "This variant isn't in an approved state right now.",
  budget_exceeded: "This would exceed the engagement's metered budget for the current period.",
  creator_info_unverified: "TikTok requires the creator's live settings to be re-checked immediately before publishing, and that check isn't available yet — refused until it is.",
  creator_selection_no_longer_permitted: "The creator's live settings no longer allow what was approved (privacy, comments, duet/stitch, etc. changed since approval).",

  // ── CLIENT_REVIEW_REFUSAL (SMM-31/32, D-16) — the client sign-off gate, composed IN FRONT of the
  // six-stage chain above (never a 7th stage in it). Reported as `stage:"client_review"` on the same
  // dry-run/dispatch surfaces; every token below renders as itself, same criterion-5 discipline.
  client_review_not_requested: "This engagement requires the client's sign-off before this can publish, and nobody has asked the client yet.",
  client_review_pending: "Waiting on the client — they haven't decided yet.",
  client_review_changes_requested: "The client asked for changes. Address their feedback, then ask again — asking again resets the same review rather than filing a new one.",
  client_review_withdrawn: "The request for the client's sign-off was withdrawn, and nobody has asked again since.",
  client_review_stale: "The client approved this, but the content has changed since — their approval no longer matches what's here now. Ask again before this can publish.",
};

/** Maps a controller refusal TOKEN to a short, human sentence. Falls back to the raw token
 *  (still the contract, per §19) if this file doesn't name it yet — never invented prose. */
export function describeRefusal(token: string): string {
  return REFUSAL_LABELS[token] ?? token;
}
