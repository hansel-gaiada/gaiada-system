import { describe, it, expect } from "vitest";
import {
  SOCIAL_NETWORKS, EMPTY_TOOL_SCOPE, QUOTA_UNKNOWN_RULE, IMAGE_GENERATION_UNAVAILABLE_WARNING,
  describeRefusal,
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
});
