import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";
import type { QuarantineBody, QuarantinedUpload } from "@/lib/webdeskMediaReviewModel";

vi.mock("@/lib/webdeskMediaReviewActions", () => ({ listQuarantineAction: vi.fn(), reviewUploadAction: vi.fn() }));

import * as A from "@/lib/webdeskMediaReviewActions";
import { QuarantinePanel } from "./QuarantinePanel";

const a = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const PEOPLE = { staff1: "Dewi" };
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const upload = (id: string, over: Partial<QuarantinedUpload["asset"]> = {}, allowedReview: boolean | null = true): QuarantinedUpload => ({
  asset: {
    assetId: id, url: `/v1/t/gaiada/media/${id}`, mime: "image/png", sizeBytes: 204_800, scanStatus: "clean", title: null, alt: {}, tags: [],
    originalFilename: `${id}.png`, width: 640, height: 480, createdBy: "contrib-9", createdAt: "2026-10-27T01:00:00Z", updatedAt: "2026-10-27T01:00:00Z", deletedAt: null, ...over,
  },
  reviewState: "quarantined",
  allowedReview,
});
const body = (assets: QuarantinedUpload[], hasMore = false): QuarantineBody => ({ assets, page: { cursor: null, hasMore, limit: 50 } });
const mount = (assets: QuarantinedUpload[], hasMore = false) => render(<QuarantinePanel scope={SCOPE} initial={body(assets, hasMore)} people={PEOPLE} />);
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
const reviewed = (decision: "accept" | "reject", alreadyDecided = false) => ok({ assetId: "x", decision, alreadyDecided, reviewState: decision === "accept" ? ("accepted" as const) : ("rejected" as const) });

beforeEach(() => {
  Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  a.listQuarantineAction.mockResolvedValue(ok(body([])));
});
afterEach(cleanup);

describe("the quarantine list", () => {
  it("shows each held upload with its type, size, who sent it and a plain note that nothing is public", () => {
    mount([upload("a1", { title: "Hero shot" })]);
    const row = screen.getByTestId("quarantine-row").textContent ?? "";
    expect(row).toMatch(/Hero shot/);
    expect(row).toMatch(/a1\.png/);
    expect(row).toMatch(/image\/png/);
    expect(row).toMatch(/200 KB/);
    expect(row).toMatch(/640 x 480/);
    expect(row).toMatch(/user contrib-/); // a freelance writer is usually not in the company's people list
    expect(screen.getByTestId("quarantine-note").textContent).toMatch(/nobody can see them on the website until you accept/);
  });

  it("an empty queue says nothing is waiting (a real answer: the read succeeded)", () => {
    mount([]);
    expect(screen.getByTestId("quarantine-empty").textContent).toMatch(/No uploads are waiting/);
    expect(screen.queryByTestId("quarantine-table")).toBeNull();
  });

  it("says when there are more than fit", () => {
    mount([upload("a1")], true);
    expect(screen.getByTestId("quarantine-more")).toBeTruthy();
  });
});

describe("the buttons follow `allowed.review`, per upload", () => {
  it("allowed: Accept and Reject are on; false (the uploader themselves): no buttons at all, and the reason in words; null (unknown): on, the server decides", () => {
    mount([upload("ok1", {}, true), upload("mine", {}, false), upload("unk", {}, null)]);
    const rows = screen.getAllByTestId("quarantine-row");
    expect((within(rows[0]).getByTestId("quarantine-accept") as HTMLButtonElement).disabled).toBe(false);
    expect((within(rows[0]).getByTestId("quarantine-reject") as HTMLButtonElement).disabled).toBe(false);
    expect(within(rows[1]).queryByTestId("quarantine-accept")).toBeNull();
    expect(within(rows[1]).queryByTestId("quarantine-reject")).toBeNull();
    expect(within(rows[1]).getByTestId("quarantine-not-allowed").textContent).toMatch(/can't review this upload/);
    expect((within(rows[2]).getByTestId("quarantine-accept") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("accept and reject", () => {
  it("Accept sends the decision for THAT asset, says so, and re-reads the list", async () => {
    a.reviewUploadAction.mockResolvedValue(reviewed("accept"));
    a.listQuarantineAction.mockResolvedValue(ok(body([upload("a2")])));
    mount([upload("a1", { title: "Hero shot" }), upload("a2")]);
    await click(within(screen.getAllByTestId("quarantine-row")[0]).getByTestId("quarantine-accept"));
    expect(a.reviewUploadAction).toHaveBeenCalledWith(SCOPE, "a1", "accept", expect.stringMatching(/^review-a1-accept/));
    expect(screen.getByTestId("quarantine-ok").textContent).toMatch(/Hero shot is accepted/);
    expect(a.listQuarantineAction).toHaveBeenCalledWith(SCOPE);
    expect(screen.getAllByTestId("quarantine-row")).toHaveLength(1);
  });

  it("Reject asks first (the answer is final), then sends it", async () => {
    a.reviewUploadAction.mockResolvedValue(reviewed("reject"));
    mount([upload("a1")]);
    await click(screen.getByTestId("quarantine-reject"));
    expect(a.reviewUploadAction).not.toHaveBeenCalled();
    await click(screen.getByTestId("quarantine-reject-confirm"));
    expect(a.reviewUploadAction).toHaveBeenCalledWith(SCOPE, "a1", "reject", expect.stringMatching(/^review-a1-reject/));
    expect(screen.getByTestId("quarantine-ok").textContent).toMatch(/rejected/);
  });

  it("'Keep waiting' backs out without sending anything", async () => {
    mount([upload("a1")]);
    await click(screen.getByTestId("quarantine-reject"));
    await click(screen.getByText("Keep waiting"));
    expect(a.reviewUploadAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("quarantine-accept")).toBeTruthy();
  });

  it("a decision someone already made is said so, with nothing claimed as changed", async () => {
    a.reviewUploadAction.mockResolvedValue(reviewed("accept", true));
    mount([upload("a1")]);
    await click(screen.getByTestId("quarantine-accept"));
    expect(screen.getByTestId("quarantine-ok").textContent).toMatch(/already been accepted\. Nothing changed/);
  });

  it("a refusal is said in words and the list is re-read (never a stale row that invites a second click)", async () => {
    a.reviewUploadAction.mockResolvedValue({ kind: "conflict", slug: "media-not-quarantined", message: "x", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    a.listQuarantineAction.mockResolvedValue(ok(body([])));
    mount([upload("a1")]);
    await click(screen.getByTestId("quarantine-accept"));
    expect(screen.getByTestId("quarantine-bad").textContent).toMatch(/already decided/);
    expect(a.listQuarantineAction).toHaveBeenCalled();
    expect(screen.getByTestId("quarantine-empty")).toBeTruthy();
  });

  it("a 403 says the person cannot review here; an unreachable service says nothing was changed", async () => {
    a.reviewUploadAction.mockResolvedValueOnce({ kind: "forbidden", reason: "forbidden" });
    a.listQuarantineAction.mockResolvedValue(ok(body([upload("a1")])));
    mount([upload("a1")]);
    await click(screen.getByTestId("quarantine-accept"));
    expect(screen.getByTestId("quarantine-bad").textContent).toMatch(/can't review uploads here/);
    a.reviewUploadAction.mockResolvedValueOnce({ kind: "unavailable", code: "network", reason: "network" });
    await click(screen.getByTestId("quarantine-accept"));
    expect(screen.getByTestId("quarantine-bad").textContent).toMatch(/Nothing was changed/);
  });

  it("a thrown network error is shown as an unreachable service, not as a crash", async () => {
    a.reviewUploadAction.mockRejectedValue(new Error("boom"));
    mount([upload("a1")]);
    await click(screen.getByTestId("quarantine-accept"));
    expect(screen.getByTestId("quarantine-bad").textContent).toMatch(/can't be reached/);
  });
});

// M5-W1q2 (WSK-D84): what the reviewer sees of an upload before deciding.
describe("the preview of a held upload", () => {
  it("a raster row shows a lazy thumbnail from the pass-through route, with the original filename as its alt text, a fixed max size, and NO link around it", () => {
    mount([upload("a1", { originalFilename: "hero-shot.png", title: "Hero" })]);
    const img = screen.getByTestId("quarantine-thumb") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/webdesk-media-preview/gaiada/site-1/a1");
    expect(img.getAttribute("alt")).toBe("hero-shot.png");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.style.maxWidth).toBe("160px");
    expect(img.style.maxHeight).toBe("120px");
    // no download link and no open-in-new-tab: the picture is not wrapped in, and the row holds no link to, the file
    expect(img.closest("a")).toBeNull();
    expect(screen.getByTestId("quarantine-row").querySelectorAll("a")).toHaveLength(0);
    expect(screen.getByTestId("quarantine-row").querySelectorAll("[download], [target=_blank]")).toHaveLength(0);
  });

  it("each of the five raster types gets a thumbnail", () => {
    mount(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].map((mime, i) => upload(`r${i}`, { mime })));
    expect(screen.getAllByTestId("quarantine-thumb")).toHaveLength(5);
    expect(screen.queryByTestId("quarantine-nopreview")).toBeNull();
  });

  it("SVG, HTML, PDF and video are shown by type only: 'No preview for <mime>', no <img>, no object, no iframe", () => {
    mount(["image/svg+xml", "text/html", "application/pdf", "video/mp4"].map((mime, i) => upload(`n${i}`, { mime })));
    const words = screen.getAllByTestId("quarantine-nopreview").map((e) => e.textContent);
    expect(words).toEqual(["No preview for image/svg+xml", "No preview for text/html", "No preview for application/pdf", "No preview for video/mp4"]);
    expect(screen.queryByTestId("quarantine-thumb")).toBeNull();
    const table = screen.getByTestId("quarantine-table");
    expect(table.querySelectorAll("img, object, embed, iframe, video, audio")).toHaveLength(0);
  });

  it("an image that fails to load says 'Preview unavailable' in its place; the other rows keep their thumbnails", () => {
    mount([upload("a1"), upload("a2")]);
    const [first] = screen.getAllByTestId("quarantine-thumb");
    act(() => { fireEvent.error(first); });
    expect(screen.getAllByTestId("quarantine-thumb")).toHaveLength(1);
    expect(screen.getByTestId("quarantine-preview-failed").textContent).toBe("Preview unavailable");
  });

  it("a mime this list never draws (even one that LOOKS like an image) is a name only: image/svg+xml and an unknown image type", () => {
    mount([upload("s1", { mime: "image/svg+xml" }), upload("s2", { mime: "image/x-icon" }), upload("s3", { mime: "IMAGE/PNG" })]);
    expect(screen.queryByTestId("quarantine-thumb")).toBeNull();
    expect(screen.getAllByTestId("quarantine-nopreview")).toHaveLength(3);
  });
});
