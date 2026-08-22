// SMM-08 — the validation matrix. Pure functions; no DB, no Cerbos, no network.
//
// The point of this suite is the DESIGN CLAIM in D-12: "we never let a human queue what the API
// will reject". Each case below is a rejection the network would have made, caught before an
// approver was asked to sign off on it.
import { describe, it, expect } from "vitest";
import { validateVariant, checkQuota, estimateCostUsd, NETWORKS, isNetwork, normalizeMediaFormat } from "./media-rules";

const img = (alt = "a photo", format?: string) => ({ fileId: "f1", kind: "image" as const, alt, ...(format ? { format } : {}) });
const vid = (format?: string) => ({ fileId: "v1", kind: "video" as const, ...(format ? { format } : {}) });

describe("media rules (SMM-08 / design D-12)", () => {
  it("covers every network the schema admits — no silent gap between CHECK and validator", () => {
    // 0105's `network` CHECK and this validator must agree, or a variant can be stored for a
    // network nothing knows how to validate, and it sails through to dispatch unchecked.
    expect(NETWORKS.sort()).toEqual([
      "bluesky", "facebook", "instagram", "linkedin", "mastodon",
      "pinterest", "threads", "tiktok", "x", "youtube",
    ]);
    expect(isNetwork("myspace")).toBe(false);
  });

  it("accepts a well-formed Instagram feed post", () => {
    const r = validateVariant("instagram", { body: "Morning light ☕ #coffee", media: [img()], settings: { igType: "feed" } },
      { igPosts24h: { used: 3, cap: 25 } });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("refuses an Instagram post with no media, and says which rule", () => {
    const r = validateVariant("instagram", { body: "text only" }, { igPosts24h: { used: 0, cap: 25 } });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain("media_required");
  });

  it("counts caption length in code points, not UTF-16 units", () => {
    // 300 astral-plane emoji = 300 characters to Instagram and to a human, but 600 to `.length`.
    // Counting units would refuse a caption that is legitimately fine — and would do it at 1100
    // emoji for a 2200 limit, i.e. exactly half the real allowance.
    const emoji = "😀".repeat(300);
    expect(validateVariant("instagram", { body: emoji, media: [img()] }).errors.map((e) => e.rule))
      .not.toContain("body_too_long");
    expect([...emoji].length).toBe(300);
    expect(emoji.length).toBe(600); // the trap this guards
  });

  it("refuses an over-long caption on a hard-limit network, with the overage named", () => {
    const r = validateVariant("linkedin", { body: "x".repeat(3050) });
    expect(r.ok).toBe(false);
    const e = r.errors.find((x) => x.rule === "body_too_long");
    expect(e?.message).toContain("by 50");
  });

  it("treats X's 280 as a SOFT limit — premium accounts exist and we cannot see the tier", () => {
    const r = validateVariant("x", { body: "x".repeat(400) });
    expect(r.ok).toBe(true); // not refused
    expect(r.warnings.map((w) => w.rule)).toContain("body_over_base_limit");
  });

  it("refuses a mixed-media carousel and an over-count carousel", () => {
    expect(validateVariant("instagram", { body: "b", media: [img(), vid()] }).errors.map((e) => e.rule))
      .toContain("mixed_media_kinds");
    expect(validateVariant("instagram", { body: "b", media: Array.from({ length: 11 }, () => img()) }).errors.map((e) => e.rule))
      .toContain("too_many_media");
  });

  it("refuses video-only networks given an image, and a reel given an image", () => {
    expect(validateVariant("tiktok", { body: "b", media: [img()] }).errors.map((e) => e.rule))
      .toContain("wrong_media_kind");
    expect(validateVariant("instagram", { body: "b", media: [img()], settings: { igType: "reel" } }).errors.map((e) => e.rule))
      .toContain("reel_requires_video");
  });

  it("refuses a first comment on a network that has no such surface", () => {
    expect(validateVariant("x", { body: "hi", firstComment: "#tags" }).errors.map((e) => e.rule))
      .toContain("first_comment_unsupported");
  });

  it("counts hashtags across body AND first comment — the IG placement trick does not evade the cap", () => {
    const body = "launch day";
    const firstComment = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    const r = validateVariant("instagram", { body, firstComment, media: [img()] });
    expect(r.errors.map((e) => e.rule)).toContain("too_many_hashtags");
  });

  it("warns — never refuses — on missing alt text", () => {
    const r = validateVariant("instagram", { body: "b", media: [{ fileId: "f", kind: "image" }] });
    expect(r.warnings.map((w) => w.rule)).toContain("missing_alt_text");
    expect(r.errors.map((e) => e.rule)).not.toContain("missing_alt_text");
  });

  it("refuses an attachment with no uploaded file behind it", () => {
    expect(validateVariant("facebook", { body: "b", media: [{ kind: "image", alt: "x" }] }).errors.map((e) => e.rule))
      .toContain("media_missing_file");
  });

  it("tells the operator that TikTok will not auto-publish in inbox mode", () => {
    const r = validateVariant("tiktok", { body: "b", media: [vid()], settings: { tiktokMode: "inbox" } });
    expect(r.ok).toBe(true);
    expect(r.warnings.find((w) => w.rule === "tiktok_inbox_mode")?.message).toMatch(/does not auto-publish/);
  });

  it("validates per-network setting enums", () => {
    expect(validateVariant("instagram", { body: "b", media: [img()], settings: { igType: "story-ish" } }).errors.map((e) => e.rule))
      .toContain("invalid_ig_type");
    expect(validateVariant("youtube", { body: "b", media: [vid()], settings: { ytVisibility: "secret" } }).errors.map((e) => e.rule))
      .toContain("invalid_yt_visibility");
  });
});

describe("media format (SMM-37, addendum §A4f item 2) — Instagram accepts JPEG only", () => {
  it("refuses a PNG image on Instagram, and says which rule", () => {
    const r = validateVariant("instagram", { body: "b", media: [img("alt", "png")] });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain("unsupported_media_format");
  });

  it("refuses a WebP image on Instagram too", () => {
    const r = validateVariant("instagram", { body: "b", media: [img("alt", "webp")] });
    expect(r.errors.map((e) => e.rule)).toContain("unsupported_media_format");
  });

  it("accepts a JPEG image on Instagram, format stated explicitly", () => {
    const r = validateVariant("instagram", { body: "b", media: [img("alt", "jpeg")] });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts jpg/JPG/.jpg/image-jpeg-mime spellings as jpeg", () => {
    for (const spelling of ["jpg", "JPG", ".jpg", "image/jpeg", "JPEG"]) {
      const r = validateVariant("instagram", { body: "b", media: [img("alt", spelling)] });
      expect(r.errors.map((e) => e.rule)).not.toContain("unsupported_media_format");
    }
  });

  it("warns — never refuses — when the format is not known at all", () => {
    // A variant attached before this ticket added `MediaItem.format` must not suddenly fail.
    const r = validateVariant("instagram", { body: "b", media: [img()] });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.rule)).toContain("media_format_unknown");
    expect(r.errors.map((e) => e.rule)).not.toContain("unsupported_media_format");
  });

  it("does not check format on a network with no documented restriction", () => {
    // Facebook has no format restriction in this file's research trail — a PNG must sail through.
    const r = validateVariant("facebook", { body: "b", media: [img("alt", "png")] });
    expect(r.errors.map((e) => e.rule)).not.toContain("unsupported_media_format");
    expect(r.warnings.map((w) => w.rule)).not.toContain("media_format_unknown");
  });

  it("normalizeMediaFormat folds aliases and strips MIME/dot prefixes", () => {
    expect(normalizeMediaFormat("jpg")).toBe("jpeg");
    expect(normalizeMediaFormat(".PNG")).toBe("png");
    expect(normalizeMediaFormat("image/webp")).toBe("webp");
    expect(normalizeMediaFormat(undefined)).toBeUndefined();
    expect(normalizeMediaFormat("")).toBeUndefined();
  });
});

describe("Facebook's native schedule window (SMM-37, addendum §A4i) — 10 minutes to 30 days", () => {
  const NOW = new Date("2026-08-13T12:00:00Z");

  it("refuses a post scheduled only 2 minutes out", () => {
    const scheduledAt = new Date(NOW.getTime() + 2 * 60_000).toISOString();
    const r = validateVariant("facebook", { body: "b", scheduledAt }, undefined, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain("facebook_schedule_window");
  });

  it("refuses a post scheduled 45 days out", () => {
    const scheduledAt = new Date(NOW.getTime() + 45 * 24 * 60 * 60_000).toISOString();
    const r = validateVariant("facebook", { body: "b", scheduledAt }, undefined, NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain("facebook_schedule_window");
  });

  it("accepts a post scheduled comfortably inside the window", () => {
    const scheduledAt = new Date(NOW.getTime() + 3 * 24 * 60 * 60_000).toISOString();
    const r = validateVariant("facebook", { body: "b", scheduledAt }, undefined, NOW);
    expect(r.errors.map((e) => e.rule)).not.toContain("facebook_schedule_window");
  });

  it("accepts the exact boundaries — 10 minutes and 30 days", () => {
    const min = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const max = new Date(NOW.getTime() + 30 * 24 * 60 * 60_000).toISOString();
    expect(validateVariant("facebook", { body: "b", scheduledAt: min }, undefined, NOW).errors.map((e) => e.rule))
      .not.toContain("facebook_schedule_window");
    expect(validateVariant("facebook", { body: "b", scheduledAt: max }, undefined, NOW).errors.map((e) => e.rule))
      .not.toContain("facebook_schedule_window");
  });

  it("does not apply the window when there is no scheduledAt (publish now)", () => {
    const r = validateVariant("facebook", { body: "b" }, undefined, NOW);
    expect(r.errors.map((e) => e.rule)).not.toContain("facebook_schedule_window");
  });

  it("is NOT checked on Instagram — no native API scheduling exists to violate", () => {
    const scheduledAt = new Date(NOW.getTime() + 45 * 24 * 60 * 60_000).toISOString();
    const r = validateVariant("instagram", { body: "b", media: [img("alt", "jpeg")], scheduledAt }, undefined, NOW);
    expect(r.errors.map((e) => e.rule)).not.toContain("facebook_schedule_window");
  });
});

describe("quota — unknown is not zero", () => {
  it("refuses at the cap", () => {
    const r = checkQuota("instagram", { igPosts24h: { used: 25, cap: 25 } });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe("quota_exhausted");
  });

  it("warns near the cap", () => {
    expect(checkQuota("instagram", { igPosts24h: { used: 24, cap: 25 } }).warnings.map((w) => w.rule))
      .toContain("quota_near");
  });

  it("WARNS when the counter is missing — it must never read as 'zero used'", () => {
    // The failure this prevents: confidently queueing the 26th post of the day because the registry
    // had not synced. An unknown quota can only ever warn.
    const r = checkQuota("instagram", undefined);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.rule)).toContain("quota_unknown");
    expect(checkQuota("instagram", {}).warnings.map((w) => w.rule)).toContain("quota_unknown");
  });
});

describe("YouTube quota (SMM-37) — the videos.insert bucket gates uploads, NOT the 10,000-unit pool", () => {
  it("refuses at the videos.insert cap even with the unit pool wide open", () => {
    // The exact failure this ticket closes: a reading built on the old single-pool model would see
    // "1,600/10,000 used" and report headroom while uploads are already blocked.
    const r = checkQuota("youtube", {
      youtubeQuota: { videosInsertCallsToday: { used: 100, cap: 100 }, otherUnitsToday: { used: 1600, cap: 10000 } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe("quota_exhausted");
  });

  it("warns near the videos.insert cap", () => {
    expect(checkQuota("youtube", { youtubeQuota: { videosInsertCallsToday: { used: 99, cap: 100 } } }).warnings.map((w) => w.rule))
      .toContain("quota_near");
  });

  it("WARNS when the videos.insert counter is missing — never reads as zero used", () => {
    expect(checkQuota("youtube", undefined).warnings.map((w) => w.rule)).toContain("quota_unknown");
    expect(checkQuota("youtube", { youtubeQuota: {} }).warnings.map((w) => w.rule)).toContain("quota_unknown");
    // Having the OTHER buckets populated does not count as "known" for videos.insert.
    expect(checkQuota("youtube", { youtubeQuota: { searchListCallsToday: { used: 1, cap: 100 } } }).warnings.map((w) => w.rule))
      .toContain("quota_unknown");
  });

  it("has plenty of headroom when videos.insert itself has headroom", () => {
    const r = checkQuota("youtube", { youtubeQuota: { videosInsertCallsToday: { used: 3, cap: 100 } } });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe("cost estimate — the price of the click, before the click", () => {
  const pricing = { perPostUsd: 0.015, perPostWithLinkUsd: 0.2 };

  it("is zero, and never refuses, for every unmetered network — even with no xPricing configured", () => {
    for (const n of NETWORKS.filter((x) => x !== "x")) {
      expect(estimateCostUsd(n, { body: "hello https://example.com" }, null)).toEqual({ ok: true, costUsd: 0 });
    }
  });

  it("prices an X post, and prices a link post higher, when xPricing is configured", () => {
    expect(estimateCostUsd("x", { body: "hello" }, pricing)).toEqual({ ok: true, costUsd: 0.015 });
    expect(estimateCostUsd("x", { body: "read this https://gaiada.com" }, pricing)).toEqual({ ok: true, costUsd: 0.2 });
  });

  // SMM-22 defect class #4: an absent price must refuse, not default to zero — a zero price is an
  // unmetered spend.
  it("refuses x_price_not_configured for X when no pricing is configured, rather than defaulting to $0", () => {
    expect(estimateCostUsd("x", { body: "hello" }, null)).toEqual({ ok: false, reason: "x_price_not_configured" });
    expect(estimateCostUsd("x", { body: "read this https://gaiada.com" }, null)).toEqual({
      ok: false, reason: "x_price_not_configured",
    });
  });
});
