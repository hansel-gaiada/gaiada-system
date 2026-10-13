import { describe, it, expect } from "vitest";
import {
  reviewChip, versionBadge, roundStatusLabel, errorToken, creativeErrorSentence, FORBIDDEN_SENTENCE,
  visibleActions, openRoundOf, assetListPath, assetVersionsPath, assetReviewsPath, assetContentHref,
  type ReviewRound,
} from "./creativeReviews";

describe("DW-6h review chip", () => {
  it("maps the three states a reader acts on", () => {
    expect(reviewChip({ status: "open" })).toEqual({ label: "In review" });
    expect(reviewChip({ status: "approved" })).toEqual({ label: "Approved" });
    expect(reviewChip({ status: "changes_requested" })).toEqual({ label: "Changes requested" });
  });
  it("shows nothing for no round, a withdrawn round, a superseded round or an unknown status", () => {
    expect(reviewChip(null)).toBeNull();
    expect(reviewChip(undefined)).toBeNull();
    expect(reviewChip({ status: "withdrawn" })).toBeNull();
    expect(reviewChip({ status: "superseded" })).toBeNull();
    expect(reviewChip({ status: "bogus" })).toBeNull();
  });
  it("labels every round status in words", () => {
    expect(roundStatusLabel("withdrawn")).toBe("Withdrawn");
    expect(roundStatusLabel("superseded")).toMatch(/newer version/);
    expect(roundStatusLabel("open")).toBe("Open");
  });
});

describe("DW-6h version badge", () => {
  it("appears only when the group has more than one version", () => {
    expect(versionBadge({ versionNo: 3, versionCount: 3 })).toBe("v3");
    expect(versionBadge({ versionNo: 2, versionCount: 2 })).toBe("v2");
    expect(versionBadge({ versionNo: 1, versionCount: 1 })).toBeNull();
  });
  it("is absent for a backend that sends no version fields", () => {
    expect(versionBadge({})).toBeNull();
  });
});

describe("DW-6h error tokens to sentences", () => {
  it("reads the token at the start of the backend message", () => {
    expect(errorToken("not_latest_version: a review can only be opened on the latest version of the asset")).toBe("not_latest_version");
    expect(errorToken("review_open")).toBe("review_open");
    expect(errorToken("something else entirely")).toBeNull();
    expect(errorToken(undefined)).toBeNull();
    // a token that is not at the start is not a token
    expect(errorToken("failed: review_open")).toBeNull();
  });
  it.each([
    ["not_latest_version: x", /isn't the latest version/],
    ["review_open: x", /review is already open/],
    ["review_not_open: x", /no longer open/],
    ["asset_deleted: x", /deleted/],
    ["asset_not_found: x", /couldn't be found/],
    ["comment_required: x", /comment/],
    ["version_conflict: x", /same moment/],
  ])("%s becomes plain words", (message, re) => {
    expect(creativeErrorSentence({ status: 409, message })).toMatch(re);
  });
  it("prefers the repeated token in `reason`", () => {
    expect(creativeErrorSentence({ status: 409, message: "garbled", reason: "review_open" })).toMatch(/already open/);
  });
  it("makes a 403 the calm line, whatever the message", () => {
    expect(creativeErrorSentence({ status: 403, message: "forbidden" })).toBe(FORBIDDEN_SENTENCE);
    expect(FORBIDDEN_SENTENCE).toBe("You can't do this on this asset.");
  });
  it("passes an unknown message through, and has a fallback for none", () => {
    expect(creativeErrorSentence({ status: 500, message: "boom" })).toBe("boom");
    expect(creativeErrorSentence({ status: 500 })).toMatch(/Try again/);
  });
});

describe("DW-6h which actions show", () => {
  const open = { round: 2, requestedBy: "u-opener" };
  it("latest version, no open round: upload and request review only", () => {
    expect(visibleActions({ isLatest: true, openRound: null, meId: "u1" })).toEqual({
      uploadVersion: true, requestReview: true, approve: false, requestChanges: false, withdraw: false,
    });
  });
  it("an older version never offers request review", () => {
    expect(visibleActions({ isLatest: false, openRound: null, meId: "u1" }).requestReview).toBe(false);
    expect(visibleActions({ isLatest: false, openRound: null, meId: "u1" }).uploadVersion).toBe(true);
  });
  it("an open round: approve, request changes and withdraw, and no request review", () => {
    expect(visibleActions({ isLatest: true, openRound: open, meId: "u1" })).toEqual({
      uploadVersion: true, requestReview: false, approve: true, requestChanges: true, withdraw: true,
    });
  });
  it("the person who opened the round is not offered approve; the rest stays", () => {
    const v = visibleActions({ isLatest: true, openRound: open, meId: "u-opener" });
    expect(v.approve).toBe(false);
    expect(v.requestChanges).toBe(true);
    expect(v.withdraw).toBe(true);
  });
  it("an open round on an older version still offers the decision actions (the round is the group's)", () => {
    const v = visibleActions({ isLatest: false, openRound: open, meId: "u1" });
    expect(v.approve && v.requestChanges && v.withdraw).toBe(true);
    expect(v.requestReview).toBe(false);
  });
  it("rounds that could not be read offer upload only", () => {
    expect(visibleActions({ isLatest: true, openRound: "unknown", meId: "u1" })).toEqual({
      uploadVersion: true, requestReview: false, approve: false, requestChanges: false, withdraw: false,
    });
  });
  it("finds the open round in a list", () => {
    const r = (round: number, status: ReviewRound["status"]) => ({ round, status }) as ReviewRound;
    expect(openRoundOf([r(3, "open"), r(2, "approved")])?.round).toBe(3);
    expect(openRoundOf([r(2, "approved")])).toBeNull();
  });
});

describe("DW-6h URL building", () => {
  it("lists the latest versions by default, with no versions param", () => {
    expect(assetListPath("t1")).toBe("/api/t1/creative/assets");
    expect(assetListPath("t1", { versions: "latest" })).toBe("/api/t1/creative/assets");
  });
  it("passes departmentId, versions=all and trainingReady", () => {
    expect(assetListPath("t1", { departmentId: "d-1" })).toBe("/api/t1/creative/assets?departmentId=d-1");
    expect(assetListPath("t1", { versions: "all" })).toBe("/api/t1/creative/assets?versions=all");
    expect(assetListPath("t1", { trainingReady: true, departmentId: "d-1", versions: "all" })).toBe(
      "/api/t1/creative/assets?trainingReady=true&departmentId=d-1&versions=all",
    );
  });
  it("builds the versions, reviews and content paths, encoding the ids", () => {
    expect(assetVersionsPath("t1", "a1")).toBe("/api/t1/creative/assets/a1/versions");
    expect(assetReviewsPath("t1", "a1")).toBe("/api/t1/creative/assets/a1/reviews");
    expect(assetVersionsPath("t1", "a/../b")).toBe("/api/t1/creative/assets/a%2F..%2Fb/versions");
    expect(assetContentHref("a1")).toBe("/api/creative-assets/a1");
  });
});
