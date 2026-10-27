import { describe, it, expect } from "vitest";
import { MediaShapeError } from "./webdeskMediaModel";
import { parseMediaReviewed, parseQuarantine, QUEUE_FORBIDDEN_COPY, reviewRefusalCopy, uploadFacts } from "./webdeskMediaReviewModel";

const asset = (over: Record<string, unknown> = {}) => ({
  assetId: "a1", url: "/v1/t/gaiada/media/a1", bucket: "media", bucketKey: "media/a1", mime: "image/png", sizeBytes: 2048, scanStatus: "clean",
  title: null, alt: {}, tags: [], originalFilename: "a1.png", width: 10, height: 20, createdBy: "contrib-1", createdAt: "2026-10-27T01:00:00Z",
  updatedAt: "2026-10-27T01:00:00Z", deletedAt: null, reviewState: "quarantined", reviewedBy: null, reviewedAt: null, allowed: { review: true }, ...over,
});
const page = { cursor: null, hasMore: false, limit: 50 };

describe("parseQuarantine", () => {
  it("reads the assets with their review state and the BFF's per-upload `allowed.review`", () => {
    const b = parseQuarantine({ assets: [asset(), asset({ assetId: "a2", allowed: { review: false } }), asset({ assetId: "a3", allowed: { review: null } })], page });
    expect(b.assets.map((u) => u.allowedReview)).toEqual([true, false, null]);
    expect(b.assets[0].reviewState).toBe("quarantined");
    expect(b.assets[0].asset.assetId).toBe("a1");
    expect(b.page).toEqual(page);
  });
  it("a body that is not the contract is drift, never data: a missing `allowed`, an unknown state, a non-boolean flag", () => {
    for (const bad of [
      { assets: [{ ...asset(), allowed: undefined }], page },
      { assets: [asset({ reviewState: "pending" })], page },
      { assets: [asset({ allowed: { review: "yes" } })], page },
      { assets: [asset({ allowed: {} })], page },
      { assets: "nope", page },
      { assets: [], page: { cursor: 5, hasMore: false, limit: 50 } },
    ]) {
      expect(() => parseQuarantine(bad), JSON.stringify(bad).slice(0, 60)).toThrow(MediaShapeError);
    }
  });
});

describe("parseMediaReviewed", () => {
  it("reads the decision, whether it was already made, and the asset's new state", () => {
    expect(parseMediaReviewed({ asset: asset({ reviewState: "accepted" }), decision: "accept", alreadyDecided: false })).toEqual({ assetId: "a1", decision: "accept", alreadyDecided: false, reviewState: "accepted" });
    expect(() => parseMediaReviewed({ asset: asset(), decision: "maybe", alreadyDecided: false })).toThrow(MediaShapeError);
    expect(() => parseMediaReviewed({ asset: asset(), decision: "accept" })).toThrow(MediaShapeError);
  });
});

describe("reviewRefusalCopy", () => {
  it("says each refusal in words", () => {
    const conflict = (slug: string) => ({ kind: "conflict", slug, message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null }) as const;
    expect(reviewRefusalCopy(conflict("media-not-quarantined"))).toMatch(/already decided/);
    expect(reviewRefusalCopy(conflict("media-asset-deleted"))).toMatch(/was deleted/);
    expect(reviewRefusalCopy({ kind: "not_found", slug: "media-asset-not-found" })).toMatch(/no longer exists/);
    expect(reviewRefusalCopy({ kind: "forbidden", reason: "forbidden" })).toBe(QUEUE_FORBIDDEN_COPY);
    expect(reviewRefusalCopy({ kind: "forbidden", reason: "An upload cannot be reviewed by the person who uploaded it." })).toMatch(/someone else has to review it/);
    expect(reviewRefusalCopy({ kind: "unavailable", code: "network", reason: "x" })).toMatch(/Nothing was changed/);
    expect(reviewRefusalCopy({ kind: "unavailable", code: "contract_drift", reason: "bad" })).toMatch(/unexpected \(bad\)/);
    expect(reviewRefusalCopy({ kind: "unavailable", code: "upstream_error", reason: "webdesk_ambiguous" })).toMatch(/couldn't confirm/);
  });
});

describe("uploadFacts", () => {
  it("is type, size and pixels", () => {
    expect(uploadFacts(parseQuarantine({ assets: [asset()], page }).assets[0].asset)).toBe("image/png · 2 KB · 10 x 20");
    expect(uploadFacts(parseQuarantine({ assets: [asset({ sizeBytes: 3_145_728, width: null, height: null })], page }).assets[0].asset)).toBe("image/png · 3.0 MB");
  });
});
