import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AssetVersion, ReviewRound } from "@/lib/creativeReviews";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/imaging", () => ({ IDENTITY_GRADE: { exposure: 0 } }));
const saveCreativeAsset = vi.fn();
vi.mock("@/lib/creativeActions", () => ({ saveCreativeAsset: (...a: unknown[]) => saveCreativeAsset(...a), setAssetTraining: vi.fn() }));
const requestReview = vi.fn();
const decideReview = vi.fn();
const withdrawReview = vi.fn();
vi.mock("@/lib/creativeReviewActions", () => ({
  requestReview: (...a: unknown[]) => requestReview(...a),
  decideReview: (...a: unknown[]) => decideReview(...a),
  withdrawReview: (...a: unknown[]) => withdrawReview(...a),
}));

import { VersionHistory, ReviewRounds, AssetActions } from "./AssetDetail";
import { AssetLibrary } from "./AssetLibrary";

const ver = (n: number, over: Partial<AssetVersion> = {}): AssetVersion => ({
  id: `a${n}`, name: "banner.webp", content_type: "image/webp", width: 10, height: 10, department_id: "d1",
  uploader_id: "u1", created_at: "2026-10-13T10:00:00Z", versionNo: n, versionGroupId: "a1", supersedesId: null,
  versionCount: 3, isLatest: n === 3, review: null, ...over,
});
const round = (n: number, over: Partial<ReviewRound> = {}): ReviewRound => ({
  id: `r${n}`, round: n, status: "approved", assetId: "a1", versionNo: 1, groupId: "a1", note: "", requestedBy: "u-op",
  requestedByName: "Opener", requestedAt: "2026-10-13T10:00:00Z", decidedBy: "u2", decidedByName: "Decider",
  decidedAt: "2026-10-13T11:00:00Z", decisionComment: null, ...over,
});

beforeEach(() => { vi.clearAllMocks(); });

describe("DW-6h version history", () => {
  it("lists versions newest first with a thumbnail each", () => {
    render(<VersionHistory result={{ kind: "ok", data: [ver(1), ver(3), ver(2)] }} currentId="a2" meId="u1" />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("v3"), expect.stringContaining("v2"), expect.stringContaining("v1"),
    ]);
    expect(items[0].textContent).toContain("(latest)");
    expect(items[1].textContent).toContain("(shown)");
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("src", "/api/creative-assets/a3");
    expect(items[0].textContent).toContain("Uploaded by you");
  });
  it("says so when empty", () => {
    render(<VersionHistory result={{ kind: "ok", data: [] }} currentId="a1" meId={null} />);
    expect(screen.getByText("No versions yet.")).toBeInTheDocument();
  });
  it("renders a refusal as a refusal, not as an empty list", () => {
    render(<VersionHistory result={{ kind: "forbidden" }} currentId="a1" meId={null} />);
    expect(screen.getByText(/don't have access to the version history/)).toBeInTheDocument();
    expect(screen.queryByText("No versions yet.")).not.toBeInTheDocument();
  });
  it("renders unavailable as not-a-statement-about-contents", () => {
    render(<VersionHistory result={{ kind: "unavailable", reason: "boom" }} currentId="a1" meId={null} />);
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});

describe("DW-6h review rounds", () => {
  it("lists rounds newest first with status, note, decision and comment", () => {
    render(<ReviewRounds result={{ kind: "ok", data: [
      round(1, { status: "changes_requested", note: "first look", decisionComment: "fix the logo" }),
      round(2, { status: "open", decidedAt: null, decidedBy: null, decidedByName: null }),
    ] }} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0].textContent).toContain("Round 2");
    expect(items[0].textContent).toContain("In review");
    expect(items[1].textContent).toContain("Round 1");
    expect(items[1].textContent).toContain("Changes requested");
    expect(items[1].textContent).toContain("Note: first look");
    expect(items[1].textContent).toContain("Comment: fix the logo");
    expect(items[1].textContent).toContain("Decided by Decider");
    expect(items[0].textContent).not.toContain("Decided by");
  });
  it("says so when empty, and refuses honestly", () => {
    const { unmount } = render(<ReviewRounds result={{ kind: "ok", data: [] }} />);
    expect(screen.getByText("No review rounds yet.")).toBeInTheDocument();
    unmount();
    render(<ReviewRounds result={{ kind: "forbidden" }} />);
    expect(screen.getByText(/don't have access to the review rounds/)).toBeInTheDocument();
  });
});

describe("DW-6h actions by state", () => {
  const rounds = (data: ReviewRound[]) => ({ kind: "ok" as const, data });
  const names = () => screen.queryAllByRole("button").map((b) => b.textContent);

  it("latest, no open round: Upload, Request review", () => {
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={rounds([round(1)])} meId="u1" />);
    expect(names()).toEqual(["Upload new version", "Request review"]);
    expect(screen.getByRole("link", { name: "Edit in Image Studio" })).toHaveAttribute("href", "/departments/d1/studio?versionOf=a3");
  });
  it("an older version: no Request review", () => {
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(1)} rounds={rounds([])} meId="u1" />);
    expect(names()).toEqual(["Upload new version"]);
  });
  it("an open round: Approve, Request changes, Withdraw for someone who did not open it", () => {
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={rounds([round(2, { status: "open" })])} meId="u1" />);
    expect(names()).toEqual(["Upload new version", "Approve", "Request changes", "Withdraw"]);
  });
  it("the opener is not offered Approve", () => {
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={rounds([round(2, { status: "open" })])} meId="u-op" />);
    expect(names()).toEqual(["Upload new version", "Request changes", "Withdraw"]);
  });
  it("unreadable rounds: Upload only", () => {
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={{ kind: "forbidden" }} meId="u1" />);
    expect(names()).toEqual(["Upload new version"]);
  });
  it("Request changes needs a comment before it can be sent", async () => {
    decideReview.mockResolvedValue({ ok: true });
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={rounds([round(2, { status: "open" })])} meId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const send = screen.getByRole("button", { name: "Send changes" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/What needs to change/), { target: { value: "fix the logo" } });
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    await waitFor(() => expect(decideReview).toHaveBeenCalledWith("a3", 2, "changes_requested", "fix the logo"));
  });
  it("shows a refusal as a calm line, not a crash", async () => {
    decideReview.mockResolvedValue({ ok: false, error: "You can't do this on this asset." });
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={rounds([round(2, { status: "open" })])} meId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("You can't do this on this asset.")).toBeInTheDocument();
    expect(decideReview).toHaveBeenCalledWith("a3", 2, "approved");
  });
  it("Request review sends the optional note", async () => {
    requestReview.mockResolvedValue({ ok: true });
    render(<AssetActions deptId="d1" latest={ver(3)} current={ver(3)} rounds={rounds([])} meId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Request review" }));
    fireEvent.change(screen.getByLabelText(/Note for the reviewer/), { target: { value: "please look" } });
    fireEvent.click(screen.getByRole("button", { name: "Send for review" }));
    await waitFor(() => expect(requestReview).toHaveBeenCalledWith("a3", "please look"));
  });
});

describe("DW-6h asset library cards", () => {
  const asset = (over: Record<string, unknown> = {}) => ({
    id: "a3", name: "banner.webp", content_type: "image/webp", width: 10, height: 10, preset_id: null, grade: null,
    department_id: "d1", has_original: true, original_byte_size: 1, graded_byte_size: 1, training_ready: true,
    created_at: "2026-10-13T10:00:00Z", versionNo: 3, versionGroupId: "a1", versionCount: 3, isLatest: true,
    review: { round: 1, status: "open" }, ...over,
  });
  it("shows the version badge and the review chip, and links to the detail", () => {
    render(<AssetLibrary deptId="d1" assets={[asset()]} />);
    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "banner.webp" })).toHaveAttribute("href", "/departments/d1/assets/a3");
  });
  it("shows neither for a single version with no round, and keeps the training count", () => {
    render(<AssetLibrary deptId="d1" assets={[asset({ versionNo: 1, versionCount: 1, review: null })]} />);
    expect(screen.queryByText("v1")).not.toBeInTheDocument();
    expect(screen.queryByText("In review")).not.toBeInTheDocument();
    expect(screen.getByText(/training exemplar/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
  it("shows nothing for a withdrawn round", () => {
    render(<AssetLibrary deptId="d1" assets={[asset({ review: { round: 1, status: "withdrawn" } })]} />);
    expect(screen.queryByText("Withdrawn")).not.toBeInTheDocument();
    expect(screen.queryByText("In review")).not.toBeInTheDocument();
  });
});
