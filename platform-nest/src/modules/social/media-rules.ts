// SMM-08 — the pre-publish validation engine (design D-12).
//
// THE RULE THIS FILE EXISTS FOR: we never let a human queue what the network's API will reject.
// Failures surface in the composer, BEFORE an approver is asked to sign off — not hours later as a
// mystery `failed` row that someone has to reverse-engineer. Postiz (or any driver) is the last
// line, never the first.
//
// Everything here is a PURE function of (network, variant, quota snapshot). No DB, no HTTP, no
// clock — so the whole matrix is unit-testable, and the same function answers for the composer's
// live validation, the submit gate, and the dispatch-time re-check. Three call sites, one
// implementation: a second copy is how "valid at submit, invalid at dispatch" appears.
//
// ── ON THE NUMBERS BELOW ────────────────────────────────────────────────────────────────────────
// These are the documented platform limits as of 2026-08. They are DELIBERATELY conservative and
// deliberately soft: a rule that is slightly too strict costs an operator one edit, while a rule
// that is too loose costs a failed publish and a confused client. Every network moves its limits
// without notice, so:
//   - Anything that would REFUSE a post is a hard `error` only where the limit is structural
//     (media counts, media kinds, an empty body where the network requires text).
//   - Length limits produce `warnings` near the boundary and `errors` past it, so a caption that
//     is 5 characters over does not silently vanish.
//   - The real network response is still authoritative. When SMM-05's driver starts returning
//     per-network rejections, feed them back HERE rather than growing a second rule set.

export type Network =
  | "instagram" | "facebook" | "tiktok" | "linkedin" | "x"
  | "youtube" | "threads" | "pinterest" | "bluesky" | "mastodon";

export interface MediaItem {
  fileId?: string;
  kind?: "image" | "video";
  alt?: string;
}

export interface VariantShape {
  body: string;
  firstComment?: string | null;
  media?: MediaItem[];
  settings?: Record<string, unknown>;
}

/** A live counter snapshot from the connector registry (`social_accounts.quota`). Absent means
 *  "not known yet" — which must NOT read as "zero used": an unknown quota can only warn, never
 *  certify. See `checkQuota`. */
export interface QuotaSnapshot {
  igPosts24h?: { used: number; cap: number };
  [k: string]: unknown;
}

export interface ValidationIssue {
  /** snake_case TOKEN — the contract. The UI and any agent branch on this, never on the prose. */
  rule: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

interface NetworkSpec {
  maxBody: number;
  /** Some networks refuse an empty body outright; others happily post media alone. */
  bodyRequired: boolean;
  maxMedia: number;
  /** null = both kinds accepted. */
  requiresMedia: "video" | "image" | null;
  mediaRequired: boolean;
  /** Networks whose hashtag conventions we actively check. */
  maxHashtags?: number;
  supportsFirstComment: boolean;
}

const SPECS: Record<Network, NetworkSpec> = {
  instagram: { maxBody: 2200, bodyRequired: false, maxMedia: 10, requiresMedia: null, mediaRequired: true, maxHashtags: 30, supportsFirstComment: true },
  facebook:  { maxBody: 63206, bodyRequired: false, maxMedia: 10, requiresMedia: null, mediaRequired: false, supportsFirstComment: true },
  // TikTok is video-only, and its API has no true scheduling — a post lands in the creator's inbox
  // for manual completion unless direct-post is approved for the app. `tiktokMode` carries that.
  tiktok:    { maxBody: 2200, bodyRequired: false, maxMedia: 1, requiresMedia: "video", mediaRequired: true, supportsFirstComment: false },
  linkedin:  { maxBody: 3000, bodyRequired: true, maxMedia: 20, requiresMedia: null, mediaRequired: false, supportsFirstComment: true },
  // X's limit depends on the posting account's tier. 280 is the floor every account has, so it is
  // what we validate against; a longer body warns rather than blocks, because a premium account can
  // legitimately post it.
  x:         { maxBody: 280, bodyRequired: true, maxMedia: 4, requiresMedia: null, mediaRequired: false, supportsFirstComment: false },
  youtube:   { maxBody: 5000, bodyRequired: false, maxMedia: 1, requiresMedia: "video", mediaRequired: true, supportsFirstComment: true },
  threads:   { maxBody: 500, bodyRequired: false, maxMedia: 10, requiresMedia: null, mediaRequired: false, supportsFirstComment: true },
  pinterest: { maxBody: 500, bodyRequired: false, maxMedia: 1, requiresMedia: "image", mediaRequired: true, supportsFirstComment: false },
  bluesky:   { maxBody: 300, bodyRequired: true, maxMedia: 4, requiresMedia: null, mediaRequired: false, supportsFirstComment: false },
  mastodon:  { maxBody: 500, bodyRequired: true, maxMedia: 4, requiresMedia: null, mediaRequired: false, supportsFirstComment: false },
};

export const NETWORKS = Object.keys(SPECS) as Network[];
export const isNetwork = (v: string): v is Network => v in SPECS;

const IG_TYPES = new Set(["feed", "reel", "story"]);
const TIKTOK_MODES = new Set(["direct", "inbox"]);
const YT_VISIBILITY = new Set(["public", "unlisted", "private"]);

export function countHashtags(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/** SMM-19 — the per-network hashtag cap this file already enforces during validation, exposed so AI
 *  hashtag drafting (`ai-drafts.ts`) constrains its OWN output to the SAME number instead of growing
 *  a second table that could silently drift from the one `validateVariant` checks against.
 *  `undefined` means the network has no documented hashtag convention we actively check. */
export function maxHashtagsFor(network: Network): number | undefined {
  return SPECS[network].maxHashtags;
}

/** Whether `network` has a first-comment surface (Instagram-style hashtag placement) — the same
 *  one-source-of-truth reasoning as `maxHashtagsFor`. */
export function supportsFirstCommentFor(network: Network): boolean {
  return SPECS[network].supportsFirstComment;
}

/** Validate ONE variant against ONE network. `quota` is optional: pass the account's live snapshot
 *  when you have it (composer, submit, dispatch) and omit it when you genuinely don't. */
export function validateVariant(network: Network, variant: VariantShape, quota?: QuotaSnapshot): ValidationResult {
  const spec = SPECS[network];
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const body = variant.body ?? "";
  const media = variant.media ?? [];
  const settings = variant.settings ?? {};

  // ── body ────────────────────────────────────────────────────────────────────────────────────
  if (spec.bodyRequired && body.trim() === "") {
    errors.push({ rule: "body_required", message: `${network} requires text in the post body` });
  }
  // Count by code POINTS, not UTF-16 units: an emoji is one character to a human and to most
  // networks, but `"".length` says 2, which would refuse a caption that is actually fine.
  const bodyLength = [...body].length;
  if (bodyLength > spec.maxBody) {
    const over = bodyLength - spec.maxBody;
    if (network === "x") {
      // The one deliberate soft limit: a premium account can post longer, and we cannot see the
      // account's tier from here. Warn with the number so the operator can judge.
      warnings.push({
        rule: "body_over_base_limit",
        message: `${bodyLength} characters exceeds X's base ${spec.maxBody}-character limit by ${over}. This posts only if the connected account has a premium tier.`,
      });
    } else {
      errors.push({
        rule: "body_too_long",
        message: `${bodyLength} characters exceeds ${network}'s ${spec.maxBody}-character limit by ${over}`,
      });
    }
  } else if (bodyLength > spec.maxBody * 0.95) {
    warnings.push({ rule: "body_near_limit", message: `${bodyLength}/${spec.maxBody} characters — close to ${network}'s limit` });
  }

  // ── media ───────────────────────────────────────────────────────────────────────────────────
  if (spec.mediaRequired && media.length === 0) {
    errors.push({ rule: "media_required", message: `${network} requires at least one ${spec.requiresMedia ?? "image or video"}` });
  }
  if (media.length > spec.maxMedia) {
    errors.push({ rule: "too_many_media", message: `${media.length} attachments exceeds ${network}'s limit of ${spec.maxMedia}` });
  }
  if (spec.requiresMedia) {
    const wrong = media.filter((m) => m.kind && m.kind !== spec.requiresMedia);
    if (wrong.length) {
      errors.push({ rule: "wrong_media_kind", message: `${network} accepts ${spec.requiresMedia} only; ${wrong.length} attachment(s) are not` });
    }
  }
  // A mixed image+video carousel is rejected by every network that accepts carousels at all.
  if (media.length > 1 && new Set(media.map((m) => m.kind).filter(Boolean)).size > 1) {
    errors.push({ rule: "mixed_media_kinds", message: "a carousel cannot mix images and videos" });
  }
  const missingAlt = media.filter((m) => m.kind === "image" && !m.alt?.trim()).length;
  if (missingAlt) {
    // A warning, not an error: alt text is an accessibility duty we hold ourselves to, but blocking
    // a client's post on it would be us imposing a rule the network does not have.
    warnings.push({ rule: "missing_alt_text", message: `${missingAlt} image(s) have no alt text` });
  }
  if (media.some((m) => !m.fileId)) {
    errors.push({ rule: "media_missing_file", message: "every attachment must reference an uploaded file" });
  }

  // ── first comment ───────────────────────────────────────────────────────────────────────────
  if (variant.firstComment?.trim() && !spec.supportsFirstComment) {
    errors.push({ rule: "first_comment_unsupported", message: `${network} has no first-comment surface` });
  }

  // ── hashtags ────────────────────────────────────────────────────────────────────────────────
  if (spec.maxHashtags !== undefined) {
    const n = countHashtags(body) + countHashtags(variant.firstComment ?? "");
    if (n > spec.maxHashtags) {
      errors.push({ rule: "too_many_hashtags", message: `${n} hashtags exceeds ${network}'s limit of ${spec.maxHashtags} (body + first comment combined)` });
    }
  }

  // ── per-network settings ────────────────────────────────────────────────────────────────────
  if (network === "instagram") {
    const t = settings.igType;
    if (t !== undefined && (typeof t !== "string" || !IG_TYPES.has(t))) {
      errors.push({ rule: "invalid_ig_type", message: "igType must be feed, reel or story" });
    }
    if (t === "reel" && media.some((m) => m.kind === "image")) {
      errors.push({ rule: "reel_requires_video", message: "an Instagram reel must be a video" });
    }
    if (t === "story" && media.length > 1) {
      errors.push({ rule: "story_single_media", message: "an Instagram story takes exactly one attachment" });
    }
  }
  if (network === "tiktok") {
    const mode = settings.tiktokMode;
    if (mode !== undefined && (typeof mode !== "string" || !TIKTOK_MODES.has(mode))) {
      errors.push({ rule: "invalid_tiktok_mode", message: "tiktokMode must be direct or inbox" });
    }
    if (mode !== "direct") {
      // Not a failure — a fact the operator must know before promising a client a posting time.
      warnings.push({
        rule: "tiktok_inbox_mode",
        message: "TikTok will place this in the creator's inbox for manual completion; it does not auto-publish at the scheduled time unless direct-post is approved for our app",
      });
    }
  }
  if (network === "youtube") {
    const vis = settings.ytVisibility;
    if (vis !== undefined && (typeof vis !== "string" || !YT_VISIBILITY.has(vis))) {
      errors.push({ rule: "invalid_yt_visibility", message: "ytVisibility must be public, unlisted or private" });
    }
  }

  // ── quota ───────────────────────────────────────────────────────────────────────────────────
  errors.push(...checkQuota(network, quota).errors);
  warnings.push(...checkQuota(network, quota).warnings);

  return { ok: errors.length === 0, errors, warnings };
}

/** Quota is checked separately so the dispatch choke-point can re-ask it alone, against a fresher
 *  snapshot, without re-running content validation.
 *
 *  UNKNOWN IS NOT ZERO. If we have no counter for a network that has one, that is a warning, never
 *  a pass — the alternative is confidently queueing the 26th Instagram post of the day because we
 *  had not synced. */
export function checkQuota(network: Network, quota?: QuotaSnapshot): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (network === "instagram") {
    const q = quota?.igPosts24h;
    if (!q || typeof q.used !== "number" || typeof q.cap !== "number") {
      warnings.push({
        rule: "quota_unknown",
        message: "Instagram's 24-hour posting quota is not known for this account (registry not synced); publishing may be refused by the API",
      });
    } else if (q.used >= q.cap) {
      errors.push({ rule: "quota_exhausted", message: `Instagram allows ${q.cap} posts per 24h and this account has used ${q.used}` });
    } else if (q.used >= q.cap - 2) {
      warnings.push({ rule: "quota_near", message: `${q.used}/${q.cap} Instagram posts used in the last 24h` });
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** The metered-cost preview shown on the composer and, decisively, on the approval card — so the
 *  human approving a publish sees the price of their click BEFORE they make it (design §05).
 *
 *  X is the only metered network in v1 and ships DISABLED (addendum D-14); this returns 0 for
 *  everything else, which is the honest answer rather than a placeholder. Re-verify the rate at
 *  SMM-22 before any client is charged against it. */
export function estimateCostUsd(network: Network, variant: VariantShape): number {
  if (network !== "x") return 0;
  const hasLink = /https?:\/\//i.test(variant.body ?? "");
  return hasLink ? 0.2 : 0.015;
}
