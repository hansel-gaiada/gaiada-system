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
// SMM-37, 2026-08-13 — three gaps closed, per docs/blueprints/smm-design-addendum-2026-08-12.md
// §A4f item 2 (media format), §A4i (Facebook's schedule window), §A4i/C2 (the YouTube quota shape).
// Also folded in: the design's old "IG ~25 posts/24h" figure was never hardcoded here (it always
// read `quota.igPosts24h.cap` live) — nothing to fix in code, but every comment/example below now
// says "whatever the live endpoint reports" rather than repeating a stale literal.
//
// ── MEDIA FORMAT: REFUSE, do not silently transcode ─────────────────────────────────────────────
// Instagram accepts JPEG only for image posts; a PNG or WebP is accepted by us and rejected by the
// API — exactly the D-12 failure. The choice here is EXPLICIT: this engine REFUSES an unsupported
// format rather than transcoding it. Reasoning: (1) transcoding needs a real image-processing
// backend, and none exists in this module or in ai-gateway-go (the same gap D-17 already named for
// generative images) — building one as a side effect of a validator would be exactly the kind of
// silent, unplanned pipeline this codebase avoids; (2) transcoding changes the bytes a human is
// about to approve into bytes they never saw, which is a worse surprise than an edit prompt; (3)
// refusing costs the operator one re-attach, which is the same trade this file already makes for
// every other structural error. If transcode-on-attach is ever wanted, it is a composer/upload
// feature with its own review, not a rule quietly added to the pure validator.
//
// Format is COMPOSER-SUPPLIED on `MediaItem.format`, the same trust boundary `MediaItem.kind`
// already uses — not derived from the `files` row. `files.content_type` is ITSELF client-supplied
// at upload time (see `core/files.controller.ts`), so re-deriving from it would add a DB join per
// variant write for zero extra assurance; the real backstop, as always, is the live network
// response. Missing format is a WARNING (`media_format_unknown`), never a silent pass and never a
// hard block — the same "unknown is not zero/compliant" doctrine `checkQuota` already uses, so
// existing variants attached before this ticket do not suddenly fail to validate.
//
// ── FACEBOOK'S NATIVE SCHEDULE WINDOW ────────────────────────────────────────────────────────────
// Facebook Pages' native scheduling API accepts `scheduled_publish_time` only 10 minutes to 30 days
// ahead of the call. Our calendar has no such bound today, so a post scheduled 45 days out (or 2
// minutes out) is accepted by us and rejected by Facebook. Checked ONLY for `facebook`: Instagram
// has NO native API scheduling at all (§A4f item 3 — our own queue publishes it, so there is no
// window to violate), TikTok's API has no true scheduling either (inbox mode), and no other network
// in this file's research trail documents a bound. If a future network turns out to have one, add
// it the same way — a per-network, evidence-cited constant, not a blanket rule. `now` is a
// parameter (default `new Date()`) so the SAME function re-run at dispatch, closer to the real API
// call, catches drift a submit-time check could not have seen — exactly why this engine has one
// implementation for all three call sites.

export type Network =
  | "instagram" | "facebook" | "tiktok" | "linkedin" | "x"
  | "youtube" | "threads" | "pinterest" | "bluesky" | "mastodon";

export interface MediaItem {
  fileId?: string;
  kind?: "image" | "video";
  alt?: string;
  /** Composer-supplied, e.g. "jpeg" | "png" | "webp" | "mp4" | "mov" | "heic" — case/dot-insensitive
   *  (`normalizeMediaFormat` handles "JPG"/"image/jpeg"/".jpg" alike). Same trust boundary as `kind`
   *  (see the header note): NOT re-derived from the `files` row, because `files.content_type` is
   *  itself client-supplied and buys no extra assurance for a DB join. Absent is a WARNING
   *  (`media_format_unknown`), never a silent pass — see `validateVariant`. */
  format?: string;
}

export interface VariantShape {
  body: string;
  firstComment?: string | null;
  media?: MediaItem[];
  settings?: Record<string, unknown>;
  /** ISO string or Date. Only consulted for networks with a documented native-scheduling window
   *  (today: `facebook`). Absent/unparseable is silently skipped — this field is optional on every
   *  other network and on an immediate ("publish now") variant. */
  scheduledAt?: string | Date | null;
}

/** A live counter snapshot from the connector registry (`social_accounts.quota`). Absent means
 *  "not known yet" — which must NOT read as "zero used": an unknown quota can only warn, never
 *  certify. See `checkQuota`.
 *
 *  `igPosts24h.cap` is READ LIVE from `GET /<IG_ID>/content_publishing_limit` (SMM-05) — never a
 *  hardcoded literal. The design carried "~25 posts/24h" since 2026-07-23; Meta's current doc says
 *  100 (and, self-contradicting on the same page, 50 for carousels). Nothing here was ever wrong in
 *  code because nothing here ever hardcoded a number — but any comment or example that still says
 *  "25" means "whatever the live endpoint reports", not a real limit. See addendum §A4f item 1.
 *
 *  `youtubeQuota` models the THREE independent daily buckets YouTube moved to on 2026-06-01:
 *  `search.list` calls (100/day), `videos.insert` calls (100/day, 1 unit each), and a 10,000-unit
 *  pool for everything else. The OLD single-pool model — a `{"youtubeUnitsToday":1600}`-shaped
 *  reading, treating an upload as costing ~1,600 units out of 10,000 — is WRONG and must not be
 *  reintroduced: a quota snapshot built on it reports headroom in the 10,000-unit pool while the
 *  100-call `videos.insert` bucket (the one that actually gates an upload) is already exhausted.
 *  That stale example still lives in `smm-design.md` §04 (the historical v1.0 base doc, frozen) and
 *  is discussed at length in `smm-design-addendum-2026-08-12.md` §A4g/§A4i (C2) and
 *  `smm-app-review-dossier.md` §C2 — this type is the fix, those docs are the record of why. */
export interface QuotaSnapshot {
  igPosts24h?: { used: number; cap: number };
  youtubeQuota?: {
    /** `search.list` calls today — its OWN 100/day bucket, 1 unit each. Not the same pool as `otherUnitsToday`. */
    searchListCallsToday?: { used: number; cap: number };
    /** `videos.insert` calls today — its OWN 100/day bucket, 1 unit each. THIS is the bucket that
     *  gates an upload; do not read `otherUnitsToday` headroom as upload headroom. */
    videosInsertCallsToday?: { used: number; cap: number };
    /** The remaining 10,000-unit/day pool for every other YouTube Data/Analytics/Reporting call. */
    otherUnitsToday?: { used: number; cap: number };
  };
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
  /** Normalized (`normalizeMediaFormat`) accepted formats for image attachments. `undefined` = no
   *  documented restriction we actively check (same "absent means unverified, not permissive-by-
   *  default-forever" posture as `maxHashtags` — add here the moment a network's restriction is
   *  confirmed, do not wait for a second ticket). */
  acceptedImageFormats?: string[];
  /** Same, for video attachments. */
  acceptedVideoFormats?: string[];
  /** Native API scheduling window, in minutes, from "now" to the earliest/latest accepted
   *  `scheduledAt`. `undefined` = no documented bound (see the header note on why only Facebook has
   *  one today). */
  scheduleWindowMinutes?: { min: number; max: number };
}

const SPECS: Record<Network, NetworkSpec> = {
  // Instagram accepts JPEG only for image posts (addendum §A4f item 2) — a PNG or WebP is accepted
  // by us and rejected by the API. See the header note for why this REFUSES rather than transcodes.
  instagram: { maxBody: 2200, bodyRequired: false, maxMedia: 10, requiresMedia: null, mediaRequired: true, maxHashtags: 30, supportsFirstComment: true, acceptedImageFormats: ["jpeg"] },
  // Facebook Pages' native scheduling is bounded 10 minutes to 30 days from the API call (addendum
  // §A4i) — the only network in this file's research trail with a documented window.
  facebook:  { maxBody: 63206, bodyRequired: false, maxMedia: 10, requiresMedia: null, mediaRequired: false, supportsFirstComment: true, scheduleWindowMinutes: { min: 10, max: 30 * 24 * 60 } },
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

/** Normalizes a composer-supplied format string for comparison against `acceptedImageFormats` /
 *  `acceptedVideoFormats`: lowercases, strips a leading dot or a "image/"/"video/" MIME prefix, and
 *  folds the one common alias worth folding ("jpg" -> "jpeg"). Returns `undefined` for empty input
 *  so callers can tell "no format supplied" from "supplied but unrecognized". */
export function normalizeMediaFormat(format?: string): string | undefined {
  if (!format) return undefined;
  const stripped = format.trim().toLowerCase().replace(/^\./, "").replace(/^(image|video)\//, "");
  if (!stripped) return undefined;
  return stripped === "jpg" ? "jpeg" : stripped;
}

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
 *  when you have it (composer, submit, dispatch) and omit it when you genuinely don't. `now`
 *  defaults to the real clock but is a parameter (not read internally) so the schedule-window check
 *  is deterministic in tests and so the SAME call re-run at dispatch, against the real dispatch
 *  moment, can catch drift a submit-time check could not have seen. */
export function validateVariant(network: Network, variant: VariantShape, quota?: QuotaSnapshot, now: Date = new Date()): ValidationResult {
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
  // ── media format (SMM-37, addendum §A4f item 2) ────────────────────────────────────────────────
  // Structural, like media count/kind: the network will flatly reject the wrong format, so an
  // unsupported one is an ERROR (never a warning) — but a MISSING format is the softer "unknown is
  // not a pass" case, matching `checkQuota`'s doctrine, so existing variants attached before this
  // ticket added `MediaItem.format` do not suddenly fail to validate.
  for (const kind of ["image", "video"] as const) {
    const accepted = kind === "image" ? spec.acceptedImageFormats : spec.acceptedVideoFormats;
    if (!accepted) continue;
    const items = media.filter((m) => m.kind === kind);
    const missingFormat = items.filter((m) => !m.format).length;
    if (missingFormat) {
      warnings.push({
        rule: "media_format_unknown",
        message: `${missingFormat} ${kind} attachment(s) have no known format; ${network} accepts ${kind === "image" ? "image" : "video"} formats [${accepted.join(", ")}] only and may refuse anything else`,
      });
    }
    const wrongFormat = items.filter((m) => m.format && !accepted.includes(normalizeMediaFormat(m.format)!));
    if (wrongFormat.length) {
      const seen = [...new Set(wrongFormat.map((m) => normalizeMediaFormat(m.format)))];
      errors.push({
        rule: "unsupported_media_format",
        message: `${network} accepts ${kind} format(s) [${accepted.join(", ")}] only; found [${seen.join(", ")}]`,
      });
    }
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

  // ── native schedule window (SMM-37, addendum §A4i) ─────────────────────────────────────────────
  // Only checked for networks with a DOCUMENTED bound (today: facebook — see SPECS above for why
  // instagram/tiktok are not here). No `scheduledAt` means "publish now" or "our own queue decides
  // the moment", which is out of scope for this check by construction.
  if (spec.scheduleWindowMinutes && variant.scheduledAt) {
    const when = variant.scheduledAt instanceof Date ? variant.scheduledAt : new Date(variant.scheduledAt);
    if (!Number.isNaN(when.getTime())) {
      const minutesOut = (when.getTime() - now.getTime()) / 60000;
      const { min, max } = spec.scheduleWindowMinutes;
      if (minutesOut < min) {
        errors.push({
          rule: "facebook_schedule_window",
          message: `Facebook's native scheduling requires at least ${min} minutes' lead time; this is ${Math.round(minutesOut)} minute(s) out`,
        });
      } else if (minutesOut > max) {
        errors.push({
          rule: "facebook_schedule_window",
          message: `Facebook's native scheduling accepts at most ${Math.round(max / 60 / 24)} days out; this is ${Math.round(minutesOut / 60 / 24)} day(s) out`,
        });
      }
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
 *  had not synced (or, for YouTube, the 101st upload against a bucket that resets independently of
 *  the 10,000-unit pool — see the `QuotaSnapshot.youtubeQuota` doc for why that bucket, not the
 *  pool, is what actually gates an upload). */
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
  if (network === "youtube") {
    // `videos.insert` is the bucket that gates an upload (100/day, 1 unit each) — NOT the 10,000-
    // unit "everything else" pool. Reading the wrong bucket is exactly the bug this ticket closes.
    const q = quota?.youtubeQuota?.videosInsertCallsToday;
    if (!q || typeof q.used !== "number" || typeof q.cap !== "number") {
      warnings.push({
        rule: "quota_unknown",
        message: "YouTube's daily videos.insert quota is not known for this account (registry not synced); publishing may be refused by the API",
      });
    } else if (q.used >= q.cap) {
      errors.push({ rule: "quota_exhausted", message: `YouTube allows ${q.cap} uploads per day and this account has used ${q.used}` });
    } else if (q.used >= q.cap - 2) {
      warnings.push({ rule: "quota_near", message: `${q.used}/${q.cap} YouTube uploads used today` });
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
