import { describe, it, expect } from "vitest";
import {
  approveAllItems, bulkSummary, changeProblem, channelLabel, decisionLine, describeDecideError, monthOptions, networkLabel, parseCursor, parseId, parseMonth, parseTab,
  portalSocialFileHref, recordedLine, shiftMonth, skipReasonText, socialHref, stateLabel, tabForState, whenLabel,
} from "./portalSocial";

// SCP-2 (BFF §63.9): the pure words and rules of the client's approval page.
describe("recorded decisions: said as recorded, never with a name", () => {
  it("names the channel the way a client says it", () => {
    expect(recordedLine({ channel: "whatsapp" })).toBe("Recorded by our team on your behalf (via WhatsApp)");
    expect(recordedLine({ channel: "email" })).toBe("Recorded by our team on your behalf (via email)");
    expect(recordedLine({ channel: "meeting" })).toBe("Recorded by our team on your behalf (via a meeting)");
    expect(recordedLine({})).toBe("Recorded by our team on your behalf");
    expect(channelLabel("sms")).toBe("sms");
  });
  it("a recorded decision's line carries the line and no staff name; a portal decision carries the contact's own name", () => {
    const recorded = decisionLine({ decisionId: "d", kind: "approved", decidedAt: "2026-10-20T04:00:00.000Z", decidedBy: null, recorded: true, channel: "whatsapp" });
    expect(recorded).toMatch(/^Approved\. Recorded by our team on your behalf \(via WhatsApp\), /);
    expect(decisionLine({ decisionId: "d", kind: "changes", changeKind: "copy", decidedAt: "2026-10-20T04:00:00.000Z", decidedBy: { name: "Dana Whitfield" }, recorded: false })).toMatch(/^Text changes asked by Dana Whitfield, /);
    expect(decisionLine({ decisionId: "d", kind: "changes", changeKind: "design", decidedAt: "2026-10-20T04:00:00.000Z", decidedBy: { name: "Dana" }, recorded: false })).toMatch(/^Design changes asked by Dana/);
  });
});

describe("describeDecideError: every refusal in words, never a token", () => {
  it("knows the codes of §63.9", () => {
    expect(describeDecideError("content_changed")).toBe("This post changed while you were looking; here is the new version.");
    expect(describeDecideError("post_not_with_client")).toMatch(/no longer waiting for your decision/);
    expect(describeDecideError("client_review_already_decided")).toMatch(/already decided differently/);
    expect(describeDecideError("not_your_decision")).toMatch(/Only the person who made this decision/);
    expect(describeDecideError("undo_window_passed")).toMatch(/too late to undo/);
    expect(describeDecideError("decision_not_found")).toMatch(/could not find that decision/);
    expect(describeDecideError("post_not_found")).toMatch(/could not find that post/);
  });
  it("a 400 is worded by its field; an unknown code is generic and never a raw snake_case token", () => {
    expect(describeDecideError("invalid_field", "note")).toMatch(/1 to 2,000 characters/);
    expect(describeDecideError("invalid_field", "changeKind")).toMatch(/text or to the design/);
    expect(describeDecideError("invalid_field", "seenHash")).toMatch(/Refresh the page/);
    expect(describeDecideError("something_new_and_odd")).toBe("That did not work. Refresh the page and try again.");
    expect(describeDecideError("A sentence the server wrote.")).toBe("A sentence the server wrote.");
  });
});

describe("approve all", () => {
  it("sends exactly the waiting posts with their hashes, at most 50", () => {
    const posts = [
      { id: "a", state: "to_review" as const, reviewHash: "ha" }, { id: "b", state: "approved" as const, reviewHash: "hb" }, { id: "c", state: "to_review" as const, reviewHash: "hc" },
      { id: "d", state: "changes_asked" as const, reviewHash: "hd" },
    ];
    expect(approveAllItems(posts)).toEqual([{ postId: "a", seenHash: "ha" }, { postId: "c", seenHash: "hc" }]);
    const many = Array.from({ length: 70 }, (_, i) => ({ id: `p${i}`, state: "to_review" as const, reviewHash: `h${i}` }));
    expect(approveAllItems(many)).toHaveLength(50);
  });
  it("summarises in plain words: what was approved, and each skipped post by its title with the reason", () => {
    const title = (id: string) => ({ a: "Post A", b: "Post B", c: "Post C" })[id] ?? id;
    expect(bulkSummary([{ postId: "a", outcome: "approved" }, { postId: "b", outcome: "approved" }], title).text).toBe("Approved 2 posts.");
    expect(bulkSummary([{ postId: "a", outcome: "approved" }], title).text).toBe("Approved 1 post.");
    expect(bulkSummary([{ postId: "a", outcome: "approved" }, { postId: "b", outcome: "skipped", reason: "content_changed" }], title).text).toBe('Approved 1 post. Skipped: "Post B" changed while you were looking.');
    expect(bulkSummary([{ postId: "b", outcome: "skipped", reason: "content_changed" }, { postId: "c", outcome: "skipped", reason: "post_not_with_client" }], title).text)
      .toBe('Nothing was approved. Skipped 2: "Post B" changed while you were looking; "Post C" was no longer waiting for you.');
    expect(skipReasonText("something_else")).toBe("could not be approved");
    expect(skipReasonText(undefined)).toBe("could not be approved");
  });
});

describe("the change request, before it is sent", () => {
  it("needs a kind, and a note of 1 to 2,000 characters", () => {
    expect(changeProblem(null, "A note")).toMatchObject({ field: "changeKind" });
    expect(changeProblem("layout", "A note")).toMatchObject({ field: "changeKind" });
    expect(changeProblem("copy", "")).toMatchObject({ field: "note" });
    expect(changeProblem("copy", "   \n ")).toMatchObject({ field: "note" });
    expect(changeProblem("copy", "x".repeat(2001))).toMatchObject({ field: "note" });
    expect(changeProblem("design", "x".repeat(2000))).toBeNull();
    expect(changeProblem("copy", "a")).toBeNull();
  });
  it("counts characters, not UTF-16 units (an emoji is one)", () => {
    expect(changeProblem("copy", "😀".repeat(2000))).toBeNull();
    expect(changeProblem("copy", "😀".repeat(2001))).toMatchObject({ field: "note" });
  });
});

describe("the URL: tab, month, client, post, cursor", () => {
  it("reads only what it knows", () => {
    expect(parseTab(undefined)).toBe("to_review");
    expect(parseTab("grid")).toBe("grid");
    expect(parseTab(["approved", "grid"])).toBe("approved");
    expect(parseTab("nonsense")).toBe("to_review");
    expect(parseMonth("2026-10")).toBe("2026-10");
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseMonth("October")).toBeNull();
    expect(parseId("soc-post-n-3")).toBe("soc-post-n-3");
    expect(parseId("../etc")).toBeNull();
    expect(parseId("a".repeat(65))).toBeNull();
    expect(parseCursor("o30")).toBe("o30");
    expect(parseCursor("eyJhIjoxfQ==")).toBe("eyJhIjoxfQ==");
    expect(parseCursor("a b")).toBeNull();
  });
  it("builds a link that keeps the other choices and drops the empty ones; the default tab is not written", () => {
    expect(socialHref({})).toBe("/portal/social");
    expect(socialHref({ tab: "to_review", month: "2026-10" })).toBe("/portal/social?month=2026-10");
    expect(socialHref({ tab: "grid", month: "2026-10", clientId: "cl-1" })).toBe("/portal/social?tab=grid&month=2026-10&clientId=cl-1");
    expect(socialHref({ tab: "grid", month: "2026-10" }, { tab: "approved" })).toBe("/portal/social?tab=approved&month=2026-10");
    expect(socialHref({ tab: "grid", cursor: "o30", post: "p1" }, { cursor: null, post: null })).toBe("/portal/social?tab=grid");
    expect(socialHref({}, { post: "p1" })).toBe("/portal/social?post=p1");
  });
  it("a post is listed on the tab of its state", () => {
    expect(tabForState("to_review")).toBe("to_review");
    expect(tabForState("approved")).toBe("approved");
    expect(tabForState("scheduled")).toBe("approved");
    expect(tabForState("live")).toBe("approved");
    expect(tabForState("changes_asked")).toBe("grid");
  });
  it("offers two months either side of this one, and the selected one if it is outside that", () => {
    expect(monthOptions("2026-10", null)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
    expect(monthOptions("2026-10", "2025-03")).toContain("2025-03");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("words and files", () => {
  it("labels", () => {
    expect(networkLabel("instagram")).toBe("Instagram");
    expect(networkLabel("tiktok")).toBe("TikTok");
    expect(networkLabel("mastodon")).toBe("Mastodon");
    expect(stateLabel("to_review")).toBe("Waiting for you");
    expect(stateLabel("live")).toBe("Published");
  });
  it("a time is shown in the display zone, the same on the server and in the browser; no date says so", () => {
    expect(whenLabel("2026-10-25T09:30:00.000Z")).toMatch(/25 Oct, 17:30/);
    expect(whenLabel(null)).toBe("No date yet");
    expect(whenLabel("nonsense")).toBe("No date yet");
  });
  it("the portal's own file route, with every part encoded", () => {
    expect(portalSocialFileHref("co-agency", "soc-post-n-3-f1")).toBe("/api/co-agency/portal/files/soc-post-n-3-f1");
    expect(portalSocialFileHref("a/b", "x?y")).toBe("/api/a%2Fb/portal/files/x%3Fy");
  });
});
