import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ItemAllowed, ItemEditorial, WdResult } from "@/lib/webdeskContentModel";
import type { EditorialHistory, EditorialInitial, EditorialState } from "@/lib/webdeskEditorialModel";

vi.mock("@/lib/webdeskEditorialActions", () => ({
  addCommentAction: vi.fn(), approveAction: vi.fn(), assignAction: vi.fn(), loadEditorialStateAction: vi.fn(), requestChangesAction: vi.fn(),
  resolveCommentAction: vi.fn(), seoSignoffAction: vi.fn(), submitForReviewAction: vi.fn(), withdrawFromReviewAction: vi.fn(),
}));

import * as A from "@/lib/webdeskEditorialActions";
import { EditorialPanel } from "./EditorialPanel";

const a = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "site-1" };
const ITEM = "item-1";
const AUTHORS = { u1: "Ayu", u2: "Budi", u3: "Citra" };
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const ack = { replayed: false, commentId: null };

const ALL: ItemAllowed = { read: true, update: true, submit: true, comment: true, request_changes: true, seo_signoff: true, approve: true, assign: true };
const NONE: ItemAllowed = { read: true, update: false, submit: false, comment: false, request_changes: false, seo_signoff: false, approve: false, assign: false };

const ed = (over: Partial<ItemEditorial> = {}): ItemEditorial => ({
  reviewRequired: true, seoSignoffRequired: false, state: "draft", authorSub: "u1", submittedVersion: null, seoSignedVersion: null, seoSignedBy: null,
  seoSignedCurrent: false, approvedVersion: null, approvedBy: null, approvedAt: null, approvedIsHead: false, dueAt: null, plannedPublishAt: null, briefRef: null,
  openComments: 0, ...over,
});
const hist = (over: Partial<EditorialHistory> = {}): EditorialHistory => ({
  itemId: ITEM, collectionKey: "service", headVersion: 3, deleted: false, editorial: ed(), events: [], eventsTruncated: false, comments: [], commentsTruncated: false, ...over,
});
const init = (editorial: ItemEditorial | undefined, allowed: ItemAllowed | undefined, history: EditorialHistory | null = hist()): EditorialInitial => ({ editorial, allowed, history, historyProblem: history ? null : "The review history couldn't be loaded because WebDesk can't be reached." });
const state = (editorial: ItemEditorial, allowed: ItemAllowed | undefined = ALL, history: EditorialHistory | null = hist()): EditorialState => ({ headVersion: 3, editorial, allowed, history, historyProblem: null });

function mount(initial: EditorialInitial, extra: Partial<React.ComponentProps<typeof EditorialPanel>> = {}) {
  return render(<EditorialPanel scope={SCOPE} itemId={ITEM} version={3} dirty={false} blocked={null} initial={initial} authors={AUTHORS} refreshKey="k1" {...extra} />);
}
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
const tid = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
const has = (id: string) => screen.queryByTestId(id) !== null;
const ACTION_IDS = ["act-submit", "act-withdraw", "act-request-changes", "act-seo-signoff", "act-approve", "act-assign"];
const shown = () => ACTION_IDS.filter(has);

beforeEach(() => {
  Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  a.loadEditorialStateAction.mockResolvedValue(ok(state(ed())));
});
afterEach(cleanup);

describe("every review state renders distinctly, in words", () => {
  it.each([
    ["draft", "Draft", "not been sent for review"],
    ["in_review", "In review", "waiting for a reviewer"],
    ["changes_requested", "Changes requested", "asked for changes"],
    ["approved", "Approved", "can be published"],
  ])("%s: the chip says %s and the sentence explains it", (s, label, phrase) => {
    mount(init(ed({ state: s }), NONE));
    const chip = screen.getByTestId("review-state");
    expect(chip.textContent).toContain(label);
    expect(chip.getAttribute("data-state")).toBe(s);
    expect(screen.getByTestId("review-sentence").textContent).toContain(phrase);
  });

  it("the four chips differ in text AND glyph (not colour alone)", () => {
    const seen: string[] = [];
    for (const s of ["draft", "in_review", "changes_requested", "approved"]) {
      const { unmount } = mount(init(ed({ state: s }), NONE));
      seen.push(screen.getByTestId("review-state").textContent ?? "");
      unmount();
    }
    expect(new Set(seen).size).toBe(4);
    expect(new Set(seen.map((t) => t.charAt(0))).size).toBe(4); // the leading glyph differs per state
  });

  it("an unknown state shows its own words, not one of the four", () => {
    mount(init(ed({ state: "on_hold" }), NONE));
    expect(screen.getByTestId("review-state").textContent).toContain("on hold");
    expect(screen.getByTestId("review-sentence").textContent).toContain("does not know");
  });

  it("no `editorial` at all: says WebDesk did not report it, and is not drawn as a draft", () => {
    mount(init(undefined, ALL, null));
    expect(screen.getByTestId("review-unknown").textContent).toMatch(/did not report this item's review state/);
    expect(has("review-state")).toBe(false);
    expect(shown()).toEqual([]);
    expect(screen.getByTestId("review-why").textContent).toMatch(/did not report/);
  });

  it("review off for the collection: no actions, and the words say why", () => {
    mount(init(ed({ reviewRequired: false }), ALL));
    expect(shown()).toEqual([]);
    expect(screen.getByTestId("review-why").textContent).toMatch(/Review is not turned on for this collection/);
    expect(screen.getByTestId("review-sentence").textContent).toMatch(/Review is not turned on/);
  });
});

describe("facts: who has it and which versions", () => {
  it("in review: author, who submitted it and when, the submitted version, no approval", () => {
    const events = [
      { id: "e1", version: 3, kind: "review.assigned", actorSub: "u3", note: null, createdAt: "2026-10-10T08:00:00Z" },
      { id: "e2", version: 3, kind: "review.submitted", actorSub: "u2", note: null, createdAt: "2026-10-11T09:00:00Z" },
    ];
    mount(init(ed({ state: "in_review", authorSub: "u1", submittedVersion: 3 }), NONE, hist({ events })));
    expect(screen.getByTestId("review-author").textContent).toBe("Ayu");
    expect(screen.getByTestId("review-submitted").textContent).toMatch(/^v3 by Budi, /);
    expect(screen.getByTestId("review-assigned-by").textContent).toMatch(/^Citra, /);
    expect(screen.getByTestId("review-approved").textContent).toBe("not approved");
  });

  it("approved: the approved version, who approved, and a warning when the head moved on", () => {
    mount(init(ed({ state: "approved", submittedVersion: 3, approvedVersion: 3, approvedBy: "u3", approvedAt: "2026-10-12T08:00:00Z", approvedIsHead: false }), NONE));
    const t = screen.getByTestId("review-approved").textContent ?? "";
    expect(t).toMatch(/^v3 by Citra, /);
    expect(t).toMatch(/Edited since/);
  });

  it("a person the directory doesn't know falls back to a short id, never blank", () => {
    mount(init(ed({ authorSub: "0123456789abcdef" }), NONE));
    expect(screen.getByTestId("review-author").textContent).toBe("user 01234567");
  });

  it("SEO sign-off: required and missing, current, and stale are three different sentences", () => {
    const { unmount } = mount(init(ed({ state: "in_review", submittedVersion: 4, seoSignoffRequired: true }), NONE));
    expect(screen.getByTestId("review-seo").textContent).toBe("required, not signed off");
    unmount();
    const b = mount(init(ed({ state: "in_review", submittedVersion: 4, seoSignoffRequired: true, seoSignedVersion: 4, seoSignedBy: "u3", seoSignedCurrent: true }), NONE));
    expect(screen.getByTestId("review-seo").textContent).toBe("signed off v4 by Citra");
    b.unmount();
    mount(init(ed({ state: "in_review", submittedVersion: 5, seoSignoffRequired: true, seoSignedVersion: 4, seoSignedCurrent: false }), NONE));
    expect(screen.getByTestId("review-seo").textContent).toMatch(/v4 was signed off, but v5 is in review now/);
  });

  it("the review log lists who did what, newest first", () => {
    const events = [
      { id: "e1", version: 3, kind: "review.submitted", actorSub: "u2", note: null, createdAt: "2026-10-11T09:00:00Z" },
      { id: "e2", version: 3, kind: "review.changes_requested", actorSub: "u3", note: "Shorter intro", createdAt: "2026-10-12T09:00:00Z" },
    ];
    mount(init(ed({ state: "changes_requested" }), NONE, hist({ events })));
    const items = within(screen.getByTestId("review-log")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toMatch(/Citra requested changes \(v3\) — "Shorter intro"/);
    expect(items[1]).toMatch(/Budi submitted for review \(v3\)/);
  });
});

describe("buttons follow `allowed` exactly", () => {
  it.each([
    ["draft", ["act-assign", "act-submit"]],
    ["changes_requested", ["act-assign", "act-submit"]],
    ["in_review", ["act-approve", "act-assign", "act-request-changes", "act-seo-signoff", "act-withdraw"]],
    ["approved", ["act-assign"]],
  ])("everything allowed, state %s: exactly %j", (s, want) => {
    mount(init(ed({ state: s, submittedVersion: s === "draft" ? null : 3 }), ALL));
    expect(shown().sort()).toEqual(want);
  });

  it("nothing allowed: no action buttons, no comment form, and the words say there is nothing to do", () => {
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), NONE));
    expect(shown()).toEqual([]);
    expect(has("review-actions")).toBe(false);
    expect(has("comment-form")).toBe(false);
    expect(screen.getByTestId("review-why").textContent).toMatch(/no review action available to you/);
  });

  it("`allowed` ABSENT: no buttons, no comment form, and the words say the permission check did not answer", () => {
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), undefined));
    expect(shown()).toEqual([]);
    expect(has("comment-form")).toBe(false);
    expect(screen.getByTestId("review-why").textContent).toMatch(/permission check for this item did not answer/);
  });

  it.each([
    ["submit", { submit: true }, ["act-submit"], "draft"],
    ["submit (withdraw side)", { submit: true }, ["act-withdraw"], "in_review"],
    ["request_changes", { request_changes: true }, ["act-request-changes"], "in_review"],
    ["seo_signoff", { seo_signoff: true }, ["act-seo-signoff"], "in_review"],
    ["approve", { approve: true }, ["act-approve"], "in_review"],
    ["assign", { assign: true }, ["act-assign"], "draft"],
  ])("only `%s` allowed: only its own button", (_n, allowed, want, s) => {
    mount(init(ed({ state: s, submittedVersion: 3 }), { ...NONE, ...allowed }));
    expect(shown()).toEqual(want);
  });

  it("a role-like key does not grant anything: only the documented action keys count", () => {
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), { ...NONE, webdev_manager: true, company_admin: true } as ItemAllowed));
    expect(shown()).toEqual([]);
  });

  it("approve is shown but disabled, with the reason, while a required SEO sign-off is missing", () => {
    mount(init(ed({ state: "in_review", submittedVersion: 4, seoSignoffRequired: true, seoSignedCurrent: false }), ALL));
    expect(tid("act-approve").disabled).toBe(true);
    expect(screen.getByTestId("review-block-why").textContent).toMatch(/SEO and AEO sign-off of v4 before it can be approved/);
    expect(tid("act-seo-signoff").disabled).toBe(false);
  });

  it("unsaved edits: submit, SEO sign-off and approve wait, with words; request changes and withdraw do not", () => {
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL), { dirty: true });
    expect(tid("act-approve").disabled).toBe(true);
    expect(tid("act-seo-signoff").disabled).toBe(true);
    expect(tid("act-request-changes").disabled).toBe(false);
    expect(tid("act-withdraw").disabled).toBe(false);
    expect(screen.getByTestId("review-block-why").textContent).toMatch(/Save your changes first/);
    cleanup();
    mount(init(ed(), ALL), { dirty: true });
    expect(tid("act-submit").disabled).toBe(true);
    expect(screen.getByTestId("review-block-why").textContent).toMatch(/submitting sends the saved version/);
  });

  it("the editor being offline (`blocked`) disables every command and says why", () => {
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL), { blocked: "Disabled until WebDesk answers again." });
    for (const id of shown()) expect(tid(id).disabled, id).toBe(true);
    expect(screen.getByTestId("review-block-why").textContent).toBe("Disabled until WebDesk answers again.");
  });
});

describe("commands", () => {
  it("submit: sends the editor's version with an idempotency key, then re-reads and shows the new state", async () => {
    a.submitForReviewAction.mockResolvedValue(ok(ack));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "in_review", submittedVersion: 3 }), ALL)));
    mount(init(ed(), ALL));
    await click(tid("act-submit"));
    expect(a.submitForReviewAction).toHaveBeenCalledWith(SCOPE, ITEM, 3, expect.stringMatching(/.{8,}/));
    expect(a.loadEditorialStateAction).toHaveBeenCalledWith(SCOPE, ITEM);
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("in_review");
    expect(screen.getByTestId("review-done").textContent).toBe("Sent for review.");
    expect(shown().sort()).toEqual(["act-approve", "act-assign", "act-request-changes", "act-seo-signoff", "act-withdraw"]);
  });

  it("withdraw and SEO sign-off send the right command (sign-off names the SUBMITTED version)", async () => {
    a.withdrawFromReviewAction.mockResolvedValue(ok(ack));
    a.seoSignoffAction.mockResolvedValue(ok(ack));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "in_review", submittedVersion: 5 }), ALL)));
    mount(init(ed({ state: "in_review", submittedVersion: 5 }), ALL), { version: 6 });
    await click(tid("act-seo-signoff"));
    expect(a.seoSignoffAction).toHaveBeenCalledWith(SCOPE, ITEM, 5, expect.any(String));
    await click(tid("act-withdraw"));
    expect(a.withdrawFromReviewAction).toHaveBeenCalledWith(SCOPE, ITEM, expect.any(String));
  });

  it("approve names the submitted version and the done sentence says it can be published", async () => {
    a.approveAction.mockResolvedValue(ok(ack));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "approved", submittedVersion: 3, approvedVersion: 3, approvedBy: "u1", approvedIsHead: true }), ALL)));
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL));
    expect(tid("act-approve").textContent).toBe("Approve v3");
    await click(tid("act-approve"));
    expect(a.approveAction).toHaveBeenCalledWith(SCOPE, ITEM, 3, expect.any(String));
    expect(screen.getByTestId("review-done").textContent).toMatch(/can now be published/);
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("approved");
  });

  it("request changes: the note is required, the form sends it with the submitted version, and the new state shows", async () => {
    a.requestChangesAction.mockResolvedValue(ok(ack));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "changes_requested", submittedVersion: 3 }), ALL)));
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL));
    expect(has("rc-form")).toBe(false);
    await click(tid("act-request-changes"));
    const send = tid("rc-send");
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("rc-note"), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("rc-note"), { target: { value: "Tighten the intro." } });
    expect(send.disabled).toBe(false);
    await click(send);
    expect(a.requestChangesAction).toHaveBeenCalledWith(SCOPE, ITEM, 3, "Tighten the intro.", expect.any(String));
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("changes_requested");
    expect(has("rc-form")).toBe(false);
    expect(screen.getByTestId("review-done").textContent).toMatch(/Changes requested/);
  });

  it("a changes-requested item offers 'Send for review again'", () => {
    mount(init(ed({ state: "changes_requested" }), ALL));
    expect(tid("act-submit").textContent).toBe("Send for review again");
  });

  it("assign: only what changed is sent; dates go as UTC midnight; nothing changed keeps Save off", async () => {
    a.assignAction.mockResolvedValue(ok(ack));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ authorSub: "u2", dueAt: "2026-10-20T00:00:00.000Z" }), ALL)));
    mount(init(ed({ authorSub: "u1", dueAt: null, briefRef: "b-1" }), ALL));
    await click(tid("act-assign"));
    expect(tid("assign-save").disabled).toBe(true);
    fireEvent.change(screen.getByTestId("assign-author"), { target: { value: "u2" } });
    fireEvent.change(screen.getByTestId("assign-due"), { target: { value: "2026-10-20" } });
    await click(tid("assign-save"));
    expect(a.assignAction).toHaveBeenCalledWith(SCOPE, ITEM, { authorSub: "u2", dueAt: "2026-10-20T00:00:00.000Z" }, expect.any(String));
    expect(screen.getByTestId("review-author").textContent).toBe("Budi");
  });

  it("assign: clearing the brief sends null", async () => {
    a.assignAction.mockResolvedValue(ok(ack));
    mount(init(ed({ briefRef: "b-1" }), ALL));
    await click(tid("act-assign"));
    fireEvent.change(screen.getByTestId("assign-brief"), { target: { value: "" } });
    await click(tid("assign-save"));
    expect(a.assignAction).toHaveBeenCalledWith(SCOPE, ITEM, { briefRef: null }, expect.any(String));
  });
});

describe("refusals in plain words", () => {
  const conflict = (slug: string): WdResult<never> => ({ kind: "conflict", slug, message: "server words", currentHeadVersion: null, currentContentHash: null, updatedAt: null });

  it.each([
    ["review-not-enabled", /not turned on for this collection/],
    ["review-state-conflict", /current review state/],
    ["review-version-mismatch", /no longer the one in review/],
    ["seo-signoff-required", /SEO and AEO sign-off/],
    ["review-not-approved", /has not been approved/],
  ])("409 %s", async (slug, re) => {
    a.approveAction.mockResolvedValue(conflict(slug));
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL));
    await click(tid("act-approve"));
    const alert = screen.getByTestId("review-refusal");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toMatch(re);
    expect(alert.textContent).not.toContain(slug);
  });

  it("a refusal that means 'it moved' re-reads the state so the buttons on screen are not stale", async () => {
    a.approveAction.mockResolvedValue(conflict("review-state-conflict"));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "changes_requested", submittedVersion: 3 }), ALL)));
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL));
    await click(tid("act-approve"));
    expect(a.loadEditorialStateAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("changes_requested");
    expect(has("act-approve")).toBe(false);
    expect(has("review-refusal")).toBe(true); // and the refusal stays readable
  });

  it("403 on approve explains maker and checker, in words", async () => {
    a.approveAction.mockResolvedValue({ kind: "forbidden", reason: "forbidden" });
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL));
    await click(tid("act-approve"));
    expect(screen.getByTestId("review-refusal").textContent).toMatch(/wrote the version being approved/);
  });

  it("WebDesk unavailable: says nothing was changed, and does not claim success", async () => {
    a.submitForReviewAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    mount(init(ed(), ALL));
    await click(tid("act-submit"));
    expect(screen.getByTestId("review-refusal").textContent).toMatch(/can't be reached\. Nothing was changed/);
    expect(has("review-done")).toBe(false);
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("draft");
  });

  it("an unconfirmed outcome (502 ambiguous) says so, and a retry REUSES the idempotency key", async () => {
    a.submitForReviewAction.mockResolvedValueOnce({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    mount(init(ed(), ALL));
    await click(tid("act-submit"));
    expect(screen.getByTestId("review-refusal").textContent).toMatch(/couldn't confirm sending it for review/);
    const first = a.submitForReviewAction.mock.calls[0][3];
    a.submitForReviewAction.mockResolvedValueOnce(ok(ack));
    await click(tid("act-submit"));
    expect(a.submitForReviewAction.mock.calls[1][3]).toBe(first);
    // success closes the intent: the next one gets a fresh key
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed(), ALL)));
    a.submitForReviewAction.mockResolvedValueOnce(ok(ack));
    await click(tid("act-submit"));
    expect(a.submitForReviewAction.mock.calls[2][3]).not.toBe(first);
  });

  it("a thrown action (the network) is words, not a crash", async () => {
    a.submitForReviewAction.mockRejectedValue(new Error("boom"));
    mount(init(ed(), ALL));
    await click(tid("act-submit"));
    expect(screen.getByTestId("review-refusal").textContent).toMatch(/Nothing was changed/);
  });

  it("controls are disabled while a command is in flight (no double submit)", async () => {
    let release: (v: WdResult<typeof ack>) => void = () => {};
    a.submitForReviewAction.mockReturnValue(new Promise((r) => { release = r; }));
    mount(init(ed(), ALL));
    await click(tid("act-submit"));
    expect(tid("act-submit").disabled).toBe(true);
    await click(tid("act-submit"));
    expect(a.submitForReviewAction).toHaveBeenCalledTimes(1);
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "in_review", submittedVersion: 3 }), ALL)));
    await act(async () => { release(ok(ack)); });
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("in_review");
  });
});

describe("re-reading the state", () => {
  it("a re-read that fails after a good write keeps the success, says the state may be out of date, and freezes the actions", async () => {
    a.submitForReviewAction.mockResolvedValue(ok(ack));
    a.loadEditorialStateAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    mount(init(ed(), ALL));
    await click(tid("act-submit"));
    expect(screen.getByTestId("review-done")).toBeTruthy();
    expect(screen.getByTestId("review-stale").textContent).toMatch(/Couldn't refresh the review state/);
    expect(tid("act-submit").disabled).toBe(true);
    expect(screen.getByTestId("review-block-why").textContent).toMatch(/until the review state can be read again/);
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "in_review", submittedVersion: 3 }), ALL)));
    await click(screen.getByTestId("review-refresh"));
    expect(has("review-stale")).toBe(false);
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("in_review");
  });

  it("when the editor re-reads the item (refreshKey changes) the panel re-reads too; the first render does not", async () => {
    const { rerender } = mount(init(ed(), ALL));
    expect(a.loadEditorialStateAction).not.toHaveBeenCalled();
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "approved", approvedVersion: 3 }), NONE)));
    await act(async () => {
      rerender(<EditorialPanel scope={SCOPE} itemId={ITEM} version={3} dirty={false} blocked={null} initial={init(ed(), ALL)} authors={AUTHORS} refreshKey="k2" />);
    });
    expect(a.loadEditorialStateAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("approved");
    expect(shown()).toEqual([]); // the new `allowed` replaced the old one
  });
});

describe("comments in the panel", () => {
  const comments = [
    { id: "c1", version: 3, anchor: "/blocks/0/props/h1", body: "Shorter?", authorSub: "u3", createdAt: "2026-10-12T08:05:00Z", resolvedAt: null, resolvedBy: null },
    { id: "c2", version: 2, anchor: null, body: "Old point", authorSub: "u2", createdAt: "2026-10-11T08:05:00Z", resolvedAt: "2026-10-11T09:00:00Z", resolvedBy: "u1" },
  ];

  it("lists open comments first, with author, version and the field they are about; resolved ones say who resolved them", () => {
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), NONE, hist({ comments: [comments[1], comments[0]] })));
    const rows = screen.getAllByTestId("comment");
    expect(rows.map((r) => r.getAttribute("data-resolved"))).toEqual(["false", "true"]);
    expect(rows[0].textContent).toMatch(/Citra/);
    expect(rows[0].textContent).toMatch(/About: h1/);
    expect(rows[1].textContent).toMatch(/Resolved by Ayu/);
    expect(screen.getByRole("heading", { name: /Comments \(1 open\)/ })).toBeTruthy();
  });

  it("empty is only said when the history loaded; an unreadable history says why, never 'no comments'", () => {
    mount(init(ed(), NONE, hist()));
    expect(screen.getByTestId("comments-empty").textContent).toBe("No comments yet.");
    cleanup();
    mount(init(ed(), NONE, null));
    expect(has("comments-empty")).toBe(false);
    expect(screen.getByTestId("comments-unavailable").textContent).toMatch(/can't be reached.*not a statement that there are none/);
  });

  it("add: sends the body and the field reference (on the submitted version), clears the form, and re-reads", async () => {
    a.addCommentAction.mockResolvedValue(ok({ replayed: false, commentId: "c9" }));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed({ state: "in_review", submittedVersion: 3, openComments: 1 }), ALL, hist({ comments: [comments[0]] }))));
    mount(init(ed({ state: "in_review", submittedVersion: 3 }), ALL), { version: 4 });
    const add = tid("comment-add");
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "Shorter?" } });
    fireEvent.change(screen.getByTestId("comment-anchor-input"), { target: { value: "/blocks/0/props/h1" } });
    expect(add.disabled).toBe(false);
    await click(add);
    expect(a.addCommentAction).toHaveBeenCalledWith(SCOPE, ITEM, 3, "Shorter?", "/blocks/0/props/h1", expect.any(String));
    expect((screen.getByTestId("comment-body") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getAllByTestId("comment")).toHaveLength(1);
    expect(screen.getByTestId("review-done").textContent).toBe("Comment added.");
  });

  it("add with no field: no anchor is sent; on a draft it comments on the editor's version", async () => {
    a.addCommentAction.mockResolvedValue(ok(ack));
    mount(init(ed(), ALL), { version: 4 });
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "Note" } });
    await click(tid("comment-add"));
    expect(a.addCommentAction).toHaveBeenCalledWith(SCOPE, ITEM, 4, "Note", undefined, expect.any(String));
  });

  it("a malformed field reference is refused on the form, with words", () => {
    mount(init(ed(), ALL));
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "Note" } });
    fireEvent.change(screen.getByTestId("comment-anchor-input"), { target: { value: "h1" } });
    expect(tid("comment-add").disabled).toBe(true);
    expect(screen.getByText(/starts with \//)).toBeTruthy();
  });

  it("a refused comment keeps what was typed and says why", async () => {
    a.addCommentAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    mount(init(ed(), ALL));
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "Keep me" } });
    await click(tid("comment-add"));
    expect(screen.getByTestId("review-refusal").textContent).toMatch(/can't be reached\. Nothing was changed/);
    expect((screen.getByTestId("comment-body") as HTMLTextAreaElement).value).toBe("Keep me");
  });

  it("a 403 on a comment re-reads `allowed`: the form goes away when the permission is gone", async () => {
    a.addCommentAction.mockResolvedValue({ kind: "forbidden", reason: "x" });
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed(), NONE)));
    mount(init(ed(), ALL));
    fireEvent.change(screen.getByTestId("comment-body"), { target: { value: "Note" } });
    await click(tid("comment-add"));
    expect(screen.getByTestId("review-refusal").textContent).toMatch(/permission/);
    expect(has("comment-form")).toBe(false);
  });

  it("resolve: a button on each OPEN comment only; it resolves, and the list is re-read", async () => {
    a.resolveCommentAction.mockResolvedValue(ok(ack));
    a.loadEditorialStateAction.mockResolvedValue(ok(state(ed(), ALL, hist({ comments: [{ ...comments[0], resolvedAt: "2026-10-12T10:00:00Z", resolvedBy: "u1" }, comments[1]] }))));
    mount(init(ed(), ALL, hist({ comments })));
    expect(screen.getAllByTestId("comment-resolve")).toHaveLength(1);
    await click(screen.getByTestId("comment-resolve"));
    expect(a.resolveCommentAction).toHaveBeenCalledWith(SCOPE, ITEM, "c1", expect.any(String));
    expect(has("comment-resolve")).toBe(false);
    expect(screen.getByTestId("review-done").textContent).toBe("Comment resolved.");
  });

  it("without `allowed.comment` the comments are read-only: no form, no Resolve", () => {
    mount(init(ed(), NONE, hist({ comments })));
    expect(has("comment-form")).toBe(false);
    expect(has("comment-resolve")).toBe(false);
    expect(screen.getByTestId("comment-no-add")).toBeTruthy();
    expect(screen.getAllByTestId("comment")).toHaveLength(2);
  });

  it("'Show field' focuses the field on the form when it is there, and says so when it is not", async () => {
    render(<input data-pointer="/blocks/0/props/h1" data-testid="h1-field" />);
    mount(init(ed(), ALL, hist({ comments: [comments[0]] })));
    await click(screen.getByTestId("comment-show-field"));
    expect(document.activeElement).toBe(screen.getByTestId("h1-field"));
    cleanup();
    mount(init(ed(), ALL, hist({ comments: [comments[0]] })));
    await click(screen.getByTestId("comment-show-field"));
    expect(screen.getByTestId("field-missed").textContent).toMatch(/isn't on this form/);
  });
});
