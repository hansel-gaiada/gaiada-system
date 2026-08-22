import { describe, it, expect } from "vitest";
import {
  SOCIAL_NETWORKS, EMPTY_TOOL_SCOPE, QUOTA_UNKNOWN_RULE, IMAGE_GENERATION_UNAVAILABLE_WARNING,
  describeRefusal, describeQuota, PUBLISH_PRECONDITION_STAGES,
  CLIENT_REVIEW_REFUSAL, evaluateClientReviewState,
  EMPTY_ASSET_LIBRARY,
  REPLY_REFUSAL, REPLY_DISPATCH_REFUSAL, REPLY_PRECONDITION_STAGES,
  describeTriage, describeSla, UNCONFIGURED_PUBLISHER_STATUS,
} from "./socialShared";

// Pure-helper tests only — no network. `readGuarded`/`platformFetch` (the networked half of
// lib/social.ts) are exercised by the pages that call them, not here — same convention
// searchMarketing.test.ts's own header states for the identical split.

describe("SOCIAL_NETWORKS", () => {
  it("lists exactly the ten networks the media-rule engine (media-rules.ts) validates against", () => {
    expect(SOCIAL_NETWORKS).toEqual([
      "instagram", "facebook", "tiktok", "linkedin", "x",
      "youtube", "threads", "pinterest", "bluesky", "mastodon",
    ]);
  });
});

describe("EMPTY_TOOL_SCOPE", () => {
  it("matches the backend's DEFAULT_TOOL_SCOPE (index.ts) key-for-key — a client-side default that", () => {
    // drifts from the server's silently makes an unenabled network read as "maybe on" the moment a
    // 404/403 degrades a scope read to this fallback.
    for (const n of SOCIAL_NETWORKS) {
      expect(EMPTY_TOOL_SCOPE.networks[n]).toBe(false);
    }
    expect(EMPTY_TOOL_SCOPE.posting).toEqual({ cadencePerWeek: 3, requiresClientOk: false });
    expect(EMPTY_TOOL_SCOPE.inbox).toEqual({ enabled: false, slaMinutes: 240, dm: false });
    expect(EMPTY_TOOL_SCOPE.ai).toEqual({ drafting: true, cloudPolish: false, imageGen: false });
    expect(EMPTY_TOOL_SCOPE.reporting).toEqual({ cadence: "monthly" });
  });

  // The two owner-decided defaults a UI must render honestly (smm-design-addendum-2026-08-12.md's
  // SMM-11 row) — pinned here so a future edit to the fallback can't silently flip either default.
  it("ships networks.x FALSE (the $0 publish path D-14 depends on)", () => {
    expect(EMPTY_TOOL_SCOPE.networks.x).toBe(false);
  });
  it("ships ai.imageGen FALSE (no generative-image backend exists — D-17)", () => {
    expect(EMPTY_TOOL_SCOPE.ai.imageGen).toBe(false);
  });
});

describe("the honesty tokens", () => {
  it("quota_unknown is its own named constant, not a string a caller has to remember to spell right", () => {
    expect(QUOTA_UNKNOWN_RULE).toBe("quota_unknown");
  });
  it("image_generation_unavailable is its own named constant", () => {
    expect(IMAGE_GENERATION_UNAVAILABLE_WARNING).toBe("image_generation_unavailable");
  });
});

describe("describeRefusal", () => {
  it("maps a known controller refusal token to a human sentence", () => {
    expect(describeRefusal("post_has_live_variants")).toMatch(/queued, publishing, or already published/);
    expect(describeRefusal("variant_native_import_immutable")).toMatch(/published by hand/);
    expect(describeRefusal("variant_not_editable")).toMatch(/no longer editable/);
    expect(describeRefusal("variant_is_live")).toMatch(/can't be deleted/);
  });

  it("falls back to the raw token for an unmapped one — never invents prose", () => {
    expect(describeRefusal("some_future_token_this_file_does_not_name_yet")).toBe("some_future_token_this_file_does_not_name_yet");
  });

  // Every token `platform-nest/src/modules/social/publish-precondition.ts`'s `PUBLISH_REFUSAL`
  // defines (the dry-run endpoint SMM-12 drives from the Composer, and the D14 executor at
  // dispatch) must render as ITSELF, not fall through to the raw-token fallback — that fallback is
  // for a genuinely unmapped FUTURE token, not an excuse to skip one of the sixteen this file
  // already knows about (criterion 5 of the agentic bar). Pinned by hand as a literal list rather
  // than importing the backend's const — `platform-ui`/`platform-nest` are separate projects with
  // no shared package layer (root CLAUDE.md) — so a token added on one side without its match here
  // is a real drift this test is meant to catch on the NEXT edit to either list, same reasoning the
  // `EMPTY_TOOL_SCOPE` test above gives for pinning the backend's default by hand.
  it("names every publish-precondition refusal token — none falls back to the raw token", () => {
    const PUBLISH_REFUSAL_TOKENS = [
      "variant_not_found", "cross_client_account", "account_not_connected", "network_disabled",
      "network_not_in_scope", "engagement_inactive", "metered_network_requires_metered_tool",
      "quota_exhausted", "media_rules_failed", "args_hash_mismatch", "already_dispatched",
      "approval_already_consumed", "variant_not_approved", "budget_exceeded",
      "creator_info_unverified", "creator_selection_no_longer_permitted",
    ];
    for (const token of PUBLISH_REFUSAL_TOKENS) {
      expect(describeRefusal(token)).not.toBe(token);
      expect(describeRefusal(token).length).toBeGreaterThan(10);
    }
  });
});

describe("PUBLISH_PRECONDITION_STAGES", () => {
  it("mirrors publish-precondition.ts's stage order exactly (scope → quota → hash → unconsumed → budget → creator_info)", () => {
    expect(PUBLISH_PRECONDITION_STAGES).toEqual(["scope", "quota", "hash", "unconsumed", "budget", "creator_info"]);
  });
});

describe("CLIENT_REVIEW_REFUSAL (SMM-31/32, D-16)", () => {
  it("mirrors client-review.ts's five tokens exactly", () => {
    expect(CLIENT_REVIEW_REFUSAL).toEqual({
      clientReviewNotRequested: "client_review_not_requested",
      clientReviewPending: "client_review_pending",
      clientReviewChangesRequested: "client_review_changes_requested",
      clientReviewWithdrawn: "client_review_withdrawn",
      clientReviewStale: "client_review_stale",
    });
  });

  // Every token this file's own vocabulary defines must render as ITSELF (criterion 5) — same
  // discipline the PUBLISH_REFUSAL case above pins.
  it("names every client-review refusal token — none falls back to the raw token", () => {
    for (const token of Object.values(CLIENT_REVIEW_REFUSAL)) {
      expect(describeRefusal(token)).not.toBe(token);
      expect(describeRefusal(token).length).toBeGreaterThan(10);
    }
  });
});

describe("evaluateClientReviewState — the client-safe mirror of evaluateClientReviewPrecondition", () => {
  it("not_requested — no row at all", () => {
    expect(evaluateClientReviewState({ status: "not_requested" }, "sha-live")).toEqual({
      ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewNotRequested,
    });
  });
  it("pending — asked, not yet decided", () => {
    expect(evaluateClientReviewState({ status: "pending" }, "sha-live")).toEqual({
      ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewPending,
    });
  });
  it("withdrawn — staff retracted the ask, nobody has asked since", () => {
    expect(evaluateClientReviewState({ status: "withdrawn" }, "sha-live")).toEqual({
      ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewWithdrawn,
    });
  });
  it("changes_requested — the client asked for changes", () => {
    expect(evaluateClientReviewState({ status: "changes_requested" }, "sha-live")).toEqual({
      ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewChangesRequested,
    });
  });
  it("approved AND the reviewed hash matches the live hash — a genuine pass", () => {
    expect(evaluateClientReviewState({ status: "approved", reviewedArgsSha256: "sha-live" }, "sha-live")).toEqual({ ok: true });
  });
  // The exact case D-15/D-16 exist for: staff edited the content after the client approved it. A
  // client who approved something that then changed has not approved the NEW thing — this must
  // read as `client_review_stale`, never as a silent pass.
  it("approved BUT the content changed since (reviewedArgsSha256 !== live argsSha256) — stale", () => {
    expect(evaluateClientReviewState({ status: "approved", reviewedArgsSha256: "sha-old" }, "sha-live")).toEqual({
      ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewStale,
    });
  });
  it("approved with no reviewedArgsSha256 at all (defensive — should not happen, but never a false pass)", () => {
    expect(evaluateClientReviewState({ status: "approved" }, "sha-live")).toEqual({
      ok: false, reason: CLIENT_REVIEW_REFUSAL.clientReviewStale,
    });
  });
});

describe("describeQuota", () => {
  it("reads Instagram's igPosts24h bucket as KNOWN when both used and cap are present", () => {
    const info = describeQuota("instagram", { igPosts24h: { used: 3, cap: 25 } });
    expect(info.status).toBe("known");
    expect(info.used).toBe(3);
    expect(info.cap).toBe(25);
  });

  it("reads Instagram as UNKNOWN — never zero — when the bucket is absent", () => {
    const info = describeQuota("instagram", {});
    expect(info.status).toBe("unknown");
    expect(info.label).not.toMatch(/\b0\b/);
  });

  it("reads Instagram as UNKNOWN when quota itself is undefined (the {} default)", () => {
    expect(describeQuota("instagram", undefined).status).toBe("unknown");
  });

  it("reads YouTube's videosInsertCallsToday bucket specifically — never otherUnitsToday's headroom", () => {
    const info = describeQuota("youtube", {
      youtubeQuota: { otherUnitsToday: { used: 10, cap: 10000 }, videosInsertCallsToday: { used: 100, cap: 100 } },
    });
    expect(info.status).toBe("known");
    expect(info.used).toBe(100);
    expect(info.cap).toBe(100);
  });

  it("reads YouTube as UNKNOWN when only the unrelated otherUnitsToday bucket is present", () => {
    const info = describeQuota("youtube", { youtubeQuota: { otherUnitsToday: { used: 1, cap: 10000 } } });
    expect(info.status).toBe("unknown");
  });

  // No quota constant exists anywhere in this module (media-rules.ts's own header) — every other
  // network has no live counter modeled at all, which is a DIFFERENT fact from "unsynced" and must
  // read as its own status, never silently folded into "unknown".
  it("reads every other network as NOT MODELED, not unknown", () => {
    for (const n of ["facebook", "tiktok", "linkedin", "x", "threads", "pinterest", "bluesky", "mastodon"] as const) {
      expect(describeQuota(n, { igPosts24h: { used: 1, cap: 2 } }).status).toBe("not_modeled");
    }
  });
});

// ── SMM-20 (asset attach only; AMENDED by D-17 — generation removed) ──────────────────────────────
describe("SMM-20 asset library refusal tokens", () => {
  it("names both new attach refusals as themselves, never a generic error (criterion 5)", () => {
    expect(describeRefusal("unsupported_asset_source")).toBe(
      "That isn't a recognised asset source (must be a file or a Studio asset).",
    );
    expect(describeRefusal("asset_not_found")).toBe(
      "That asset no longer exists (deleted, or never did) — try refreshing the library.",
    );
  });

  it("ships EMPTY_ASSET_LIBRARY as two empty arrays — the honest fallback for a 403/404 read", () => {
    expect(EMPTY_ASSET_LIBRARY).toEqual({ files: [], studioAssets: [] });
  });
});

// ── SMM-18 — the engagement inbox ──────────────────────────────────────────────────────────────────
describe("REPLY_PRECONDITION_STAGES", () => {
  it("mirrors reply-precondition.ts's stage order exactly (scope → hash → unconsumed → retention)", () => {
    expect(REPLY_PRECONDITION_STAGES).toEqual(["scope", "hash", "unconsumed", "retention"]);
  });
});

describe("REPLY_REFUSAL — eleven tokens, recounted from source (not the ten this ticket's brief named)", () => {
  it("has exactly eleven distinct tokens", () => {
    const tokens = Object.values(REPLY_REFUSAL);
    expect(new Set(tokens).size).toBe(11);
    expect(tokens.length).toBe(11);
  });

  it("names every one of them as itself — none falls back to the raw token (criterion 5)", () => {
    for (const token of Object.values(REPLY_REFUSAL)) {
      expect(describeRefusal(token)).not.toBe(token);
      expect(describeRefusal(token).length).toBeGreaterThan(10);
    }
  });

  it("source_content_purged reads as correct, expected behaviour — never as a system failure", () => {
    const sentence = describeRefusal(REPLY_REFUSAL.sourceContentPurged);
    expect(sentence).toMatch(/correct, expected behaviour/i);
    expect(sentence).not.toMatch(/\berror\b/i);
  });
});

describe("REPLY_DISPATCH_REFUSAL — four tokens", () => {
  it("has exactly the four documented tokens", () => {
    expect(REPLY_DISPATCH_REFUSAL).toEqual({
      approvalNotResolvable: "approval_not_resolvable",
      stampRaceLost: "reply_stamp_race_lost",
      capabilityUnsupported: "capability_unsupported",
      sendFailed: "reply_send_failed",
    });
  });

  it("names every one of them as itself — none falls back to the raw token", () => {
    for (const token of Object.values(REPLY_DISPATCH_REFUSAL)) {
      expect(describeRefusal(token)).not.toBe(token);
      expect(describeRefusal(token).length).toBeGreaterThan(10);
    }
  });
});

describe("platform_app_not_registered — the honest-empty-inbox token", () => {
  it("names the D-23 deferral, not a broken button", () => {
    expect(describeRefusal("platform_app_not_registered")).toMatch(/D-23/);
  });
});

describe("describeTriage — the four states must look nothing alike", () => {
  it("unclassified reads as an absence ('not yet') — visual 'absent'", () => {
    const d = describeTriage({ aiTriageStatus: "unclassified", sentiment: null, category: null, urgency: null });
    expect(d.visual).toBe("absent");
    expect(d.label).toMatch(/not yet/i);
  });

  it("unavailable reads as a distinct fact from unclassified — different visual, different label", () => {
    const d = describeTriage({ aiTriageStatus: "unavailable", sentiment: null, category: null, urgency: null });
    expect(d.visual).toBe("unavailable");
    expect(d.visual).not.toBe("absent");
    expect(d.label).not.toMatch(/not yet/i);
    expect(d.detail).toMatch(/not a guessed value/i);
  });

  it("purged reads as a compliance fact, explicitly disclaiming missing-data/failure framing", () => {
    const d = describeTriage({ aiTriageStatus: "purged", sentiment: null, category: null, urgency: null });
    expect(d.visual).toBe("purged");
    expect(d.detail).toMatch(/compliance/i);
    expect(d.detail).toMatch(/not missing data or a system failure/i);
  });

  // The exact fact this ticket's brief names by name: sentiment='neutral'+classified must be
  // distinguishable from sentiment=null+unclassified, even though a naive render might collapse
  // both into "nothing interesting to say".
  it("classified+neutral is a REAL answer, visually distinct from unclassified's absence", () => {
    const classifiedNeutral = describeTriage({ aiTriageStatus: "classified", sentiment: "neutral", category: "other", urgency: "normal" });
    const unclassified = describeTriage({ aiTriageStatus: "unclassified", sentiment: null, category: null, urgency: null });
    expect(classifiedNeutral.visual).toBe("classified");
    expect(classifiedNeutral.visual).not.toBe(unclassified.visual);
    expect(classifiedNeutral.label).not.toEqual(unclassified.label);
  });

  it("classified renders the category/urgency/sentiment triple, not just a status word", () => {
    const d = describeTriage({ aiTriageStatus: "classified", sentiment: "negative", category: "complaint", urgency: "high" });
    expect(d.label).toMatch(/complaint/i);
    expect(d.label).toMatch(/high/i);
    expect(d.detail).toMatch(/negative/i);
  });
});

describe("describeSla — never invents a fallback duration", () => {
  const NOW = "2026-08-21T12:00:00.000Z";

  it("null slaDueAt is its own real state ('none'), never rendered as overdue or on-track", () => {
    const sla = describeSla(null, NOW);
    expect(sla.state).toBe("none");
    expect(sla.label).toMatch(/no sla target/i);
  });

  it("a future due date within the hour is 'due_soon'", () => {
    const sla = describeSla("2026-08-21T12:30:00.000Z", NOW);
    expect(sla.state).toBe("due_soon");
    expect(sla.label).toMatch(/due in/i);
  });

  it("a future due date beyond the hour is 'on_track'", () => {
    const sla = describeSla("2026-08-21T15:00:00.000Z", NOW);
    expect(sla.state).toBe("on_track");
  });

  it("a past due date is 'overdue'", () => {
    const sla = describeSla("2026-08-21T11:00:00.000Z", NOW);
    expect(sla.state).toBe("overdue");
    expect(sla.label).toMatch(/overdue by/i);
  });

  it("exactly at the due instant counts as overdue, not on_track (never a false green at 0)", () => {
    expect(describeSla(NOW, NOW).state).toBe("overdue");
  });
});

describe("UNCONFIGURED_PUBLISHER_STATUS — the honest fallback for a 403/404 publisher/status read", () => {
  it("reads inboxSurface as 'none', never 'available'", () => {
    expect(UNCONFIGURED_PUBLISHER_STATUS.inboxSurface).toBe("none");
  });
});
