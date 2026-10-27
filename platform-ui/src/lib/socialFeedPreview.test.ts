import { describe, it, expect } from "vitest";
import {
  asFeedPreview, asSwapAnswer, byNewest, dateMoveForPost, isMovable, moveWords, swapAsksClient, swapDoneText, swapInput, swapRefusalText, type FeedItem,
} from "./socialFeedPreview";
import { SCP_STATUSES } from "./scpStageMachine";

// SCP-3d: the feed preview's pure helpers. The server decides every date move; these parse its answers and say them in words. `dateMoveForPost` is the UI twin
// of the server's rule (fixture `systemRules.date_moves`), read through the fixture twin: this suite pins it status by status, change case by change case.

describe("dateMoveForPost (the fixture's date_moves rule)", () => {
  it("planned, drafting and a team copy change are an edit of the date", () => {
    expect(dateMoveForPost({ status: "planned" })).toEqual({ move: "edit", refusal: null });
    expect(dateMoveForPost({ status: "drafting" })).toEqual({ move: "edit", refusal: null });
    for (const c of ["copywriter_copy", "hod_copy", "final_copy"]) expect(dateMoveForPost({ status: "changes", changeCase: c }), c).toEqual({ move: "edit", refusal: null });
  });
  it("approved and scheduled are a reschedule: the client is asked again", () => {
    expect(dateMoveForPost({ status: "approved" })).toEqual({ move: "reschedule", refusal: null });
    expect(dateMoveForPost({ status: "scheduled" })).toEqual({ move: "reschedule", refusal: null });
  });
  it("every other step, the client's copy change and the design changes are field_locked; live is post_is_live", () => {
    for (const s of ["proofread", "hod", "design", "final", "client", "blocked"]) expect(dateMoveForPost({ status: s }), s).toEqual({ move: "locked", refusal: "field_locked" });
    for (const c of ["client_copy", "client_design", "final_design"]) expect(dateMoveForPost({ status: "changes", changeCase: c }), c).toEqual({ move: "locked", refusal: "field_locked" });
    expect(dateMoveForPost({ status: "live" })).toEqual({ move: "locked", refusal: "post_is_live" });
  });
  it("answers every status of the fixture, and only planned, drafting, approved and scheduled (apart from the team copy changes) are not locked", () => {
    const movable = SCP_STATUSES.filter((s) => s !== "changes" && dateMoveForPost({ status: s }).move !== "locked");
    expect(movable).toEqual(["planned", "drafting", "approved", "scheduled"]);
  });
});

const raw = (over: Record<string, unknown> = {}) => ({
  postId: "p-1", scheduledAt: "2026-10-20T09:30:00.000Z", thumbFileId: "f-1", pipelineStatus: "approved", locked: false, title: "Harvest teaser", format: "feed",
  phase: "client_approved", simulated: false, dateMove: "reschedule", dateMoveRefusal: null, ...over,
});
const item = (over: Partial<FeedItem> = {}): FeedItem => ({ ...asFeedPreview({ items: [raw()] }).items[0], ...over });

describe("asFeedPreview", () => {
  it("reads the contract's fields and the additive ones", () => {
    const v = asFeedPreview({ items: [raw()], liveHidden: 3 });
    expect(v.liveHidden).toBe(3);
    expect(v.items[0]).toEqual({
      postId: "p-1", scheduledAt: "2026-10-20T09:30:00.000Z", thumbFileId: "f-1", pipelineStatus: "approved", locked: false, title: "Harvest teaser", format: "feed",
      phase: "client_approved", simulated: false, dateMove: "reschedule", dateMoveRefusal: null,
    });
  });
  it("a live post is locked whatever else the answer says, and never offered a move", () => {
    const i = asFeedPreview({ items: [raw({ pipelineStatus: "live", locked: false, dateMove: "edit", dateMoveRefusal: null })] }).items[0];
    expect(i).toMatchObject({ locked: true, dateMove: "locked", dateMoveRefusal: "post_is_live" });
    expect(isMovable(i)).toBe(false);
  });
  it("a post the server calls locked keeps its refusal; one with no refusal named is field_locked", () => {
    expect(asFeedPreview({ items: [raw({ pipelineStatus: "proofread", dateMove: "locked", dateMoveRefusal: "field_locked" })] }).items[0]).toMatchObject({ dateMove: "locked", dateMoveRefusal: "field_locked" });
    expect(asFeedPreview({ items: [raw({ pipelineStatus: "proofread", dateMove: "locked", dateMoveRefusal: null })] }).items[0].dateMoveRefusal).toBe("field_locked");
  });
  it("a server that does not say what a move does is read by the rule", () => {
    const no = { ...raw({ pipelineStatus: "scheduled" }) } as Record<string, unknown>;
    delete no.dateMove;
    delete no.dateMoveRefusal;
    expect(asFeedPreview({ items: [no] }).items[0].dateMove).toBe("reschedule");
  });
  it("defaults a missing title and format, and a negative or missing liveHidden to zero", () => {
    const i = asFeedPreview({ items: [raw({ title: "", format: null })], liveHidden: -2 });
    expect(i.items[0]).toMatchObject({ title: "Untitled post", format: null });
    expect(i.liveHidden).toBe(0);
  });
  it("throws on a body that is not a list or an item, so a wrong shape never reads as an empty grid", () => {
    expect(() => asFeedPreview(null)).toThrow();
    expect(() => asFeedPreview({ items: "x" })).toThrow();
    expect(() => asFeedPreview({ items: [{ postId: "p" }] })).toThrow();
  });
});

describe("the small rules", () => {
  it("orders newest date first, then the id", () => {
    const rows = [{ scheduledAt: "2026-10-01T00:00:00Z", postId: "a" }, { scheduledAt: "2026-10-03T00:00:00Z", postId: "b" }, { scheduledAt: "2026-10-03T00:00:00Z", postId: "c" }];
    expect([...rows].sort(byNewest).map((r) => r.postId)).toEqual(["c", "b", "a"]);
  });
  it("a swap asks the client again when either post is approved or scheduled", () => {
    expect(swapAsksClient(item({ dateMove: "edit" }), item({ dateMove: "edit" }))).toBe(false);
    expect(swapAsksClient(item({ dateMove: "edit" }), item({ dateMove: "reschedule" }))).toBe(true);
    expect(swapAsksClient(item({ dateMove: "reschedule" }), item({ dateMove: "reschedule" }))).toBe(true);
  });
  it("says what a move does, and why a date is locked", () => {
    expect(moveWords(item({ dateMove: "reschedule" }))).toBe("Moving its date asks the client to approve it again.");
    expect(moveWords(item({ dateMove: "edit", pipelineStatus: "planned" }))).toBe("Its date can be moved.");
    expect(moveWords(item({ dateMove: "locked", dateMoveRefusal: "post_is_live", pipelineStatus: "live", locked: true }))).toBe("Live: its date cannot be changed.");
    expect(moveWords(item({ dateMove: "locked", dateMoveRefusal: "field_locked", pipelineStatus: "proofread" }))).toBe("Its date is locked at Proofread.");
  });
  it("builds the swap's input from what the page showed", () => {
    const a = item({ postId: "p-a", pipelineStatus: "planned", scheduledAt: "2026-10-01T10:00:00.000Z" });
    const b = item({ postId: "p-b", pipelineStatus: "approved", scheduledAt: "2026-10-02T10:00:00.000Z" });
    expect(swapInput(a, b)).toEqual({
      postA: "p-a", postB: "p-b", expectedA: { status: "planned", scheduledAt: "2026-10-01T10:00:00.000Z" }, expectedB: { status: "approved", scheduledAt: "2026-10-02T10:00:00.000Z" },
    });
  });
});

describe("the swap's answer and its words", () => {
  it("parses the answer, and throws on anything else", () => {
    expect(asSwapAnswer({ posts: [{ postId: "p-1", scheduledAt: "2026-10-02T10:00:00.000Z", pipelineStatus: "client", askedClient: true }, { postId: "p-2" }] })).toEqual([
      { postId: "p-1", scheduledAt: "2026-10-02T10:00:00.000Z", pipelineStatus: "client", askedClient: true },
      { postId: "p-2", scheduledAt: null, pipelineStatus: null, askedClient: false },
    ]);
    expect(() => asSwapAnswer({})).toThrow();
    expect(() => asSwapAnswer({ posts: [{}] })).toThrow();
  });
  const title = (id: string) => ({ "p-1": "Harvest teaser", "p-2": "Studio day" })[id] ?? null;
  it("names the post a refusal is about", () => {
    expect(swapRefusalText({ status: 409, error: "field_locked", detail: { postId: "p-2", status: "proofread", field: "scheduledAt" } }, title)).toBe("Studio day: Date and time cannot be changed at Proofread.");
    expect(swapRefusalText({ status: 409, error: "post_is_live", detail: { postId: "p-1" } }, title)).toBe("Harvest teaser: The post is live and cannot change.");
    expect(swapRefusalText({ status: 409, error: "status_changed", detail: { postId: "p-1", status: "client" } }, title)).toContain("Harvest teaser: Someone moved this post");
    expect(swapRefusalText({ status: 409, error: "status_changed", detail: { postId: "p-1", status: "client" } }, title)).toContain("It is now at With the client.");
  });
  it("words the rest by the contract's code", () => {
    expect(swapRefusalText({ status: 409, error: "no_change" }, title)).toMatch(/same date and time/);
    expect(swapRefusalText({ status: 404, error: "post_not_found" }, title)).toMatch(/no longer on this client/);
    expect(swapRefusalText({ status: 403, error: "not_the_officer" }, title)).toBe("Only the client's officer can do this.");
    expect(swapRefusalText({ status: 403, error: "cancel_required" }, title)).toMatch(/cancel/);
    expect(swapRefusalText({ status: 409, error: "no_account_for_network", detail: { networks: ["instagram"] } }, title)).toContain("Instagram");
  });
  it("says which posts the client will be asked about again", () => {
    expect(swapDoneText([{ postId: "p-1", scheduledAt: null, pipelineStatus: "planned", askedClient: false }, { postId: "p-2", scheduledAt: null, pipelineStatus: "planned", askedClient: false }], title))
      .toBe("The two dates are swapped.");
    expect(swapDoneText([{ postId: "p-1", scheduledAt: null, pipelineStatus: "client", askedClient: true }, { postId: "p-2", scheduledAt: null, pipelineStatus: "client", askedClient: true }], title))
      .toBe("The two dates are swapped. The client will be asked to approve Harvest teaser and Studio day again.");
  });
});
