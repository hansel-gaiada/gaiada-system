import { describe, it, expect } from "vitest";
import {
  agoWords, asNeedsYouSocial, asWaitingGroups, clientConversationHref, followUpRefusalText, holderTitle, needsKindWords, postHref, statusWords, waitWords,
} from "./socialMessages";
import fixture from "./scpStageMachine.json";

// SCP-1j (BFF §63.7, §63.14): the Messages page's parsers and words. A body of the wrong shape must read as "cannot tell", never as a plausible empty list.

describe("asWaitingGroups", () => {
  const good = {
    groups: [{
      holder: { role: "client", label: "The client", userIds: [] },
      posts: [{ id: "p-1", title: "A post", clientName: "Acme", since: "2026-10-01T00:00:00.000Z", lastFollowUpAt: null, pipelineStatus: "client", engagementId: "e-1", clientId: "c-1" }],
    }],
  };
  it("reads the contract's shape, with the additive fields the follow-up button needs", () => {
    expect(asWaitingGroups(good)).toEqual([{
      holder: { role: "client", label: "The client", userIds: [] },
      posts: [{ id: "p-1", title: "A post", clientName: "Acme", since: "2026-10-01T00:00:00.000Z", lastFollowUpAt: null, pipelineStatus: "client", engagementId: "e-1", clientId: "c-1" }],
    }]);
  });
  it("throws on a body that is not a list of groups, so the reader says it cannot tell", () => {
    for (const bad of [null, [], "x", {}, { groups: "no" }]) expect(() => asWaitingGroups(bad)).toThrow();
  });
  it("drops a post it cannot place (no id, no time, no step) and a group left with none, and never invents one", () => {
    const messy = {
      groups: [
        { holder: { role: "approver", label: "A", userIds: ["u-1", 7] }, posts: [{ id: "p-1" }, { id: "p-2", since: "2026-10-01T00:00:00.000Z", pipelineStatus: "hod", title: "Kept" }] },
        { holder: { role: "designer" }, posts: [{ title: "No id" }] },
        { holder: "nope", posts: [] },
      ],
    };
    const out = asWaitingGroups(messy);
    expect(out).toHaveLength(1);
    expect(out[0].holder.userIds).toEqual(["u-1"]);
    expect(out[0].posts.map((p) => p.id)).toEqual(["p-2"]);
    expect(out[0].posts[0]).toMatchObject({ title: "Kept", clientName: "A client", lastFollowUpAt: null, clientId: "" });
  });
});

describe("asNeedsYouSocial", () => {
  it("reads the items and the sources that failed", () => {
    expect(asNeedsYouSocial({
      items: [{ id: "social:t:p:proofread", kind: "proofread", role: "copywriter", title: "T", clientName: "C", since: "2026-10-01T00:00:00.000Z", due: "2026-10-05", href: "/d/p" }],
      partial: ["post metrics"],
    })).toEqual({
      items: [{ id: "social:t:p:proofread", kind: "proofread", role: "copywriter", title: "T", clientName: "C", since: "2026-10-01T00:00:00.000Z", due: "2026-10-05", href: "/d/p" }],
      partial: ["post metrics"],
    });
  });
  it("throws on a body that is not one, and drops a row without a link or a time", () => {
    for (const bad of [null, [], {}, { items: 1 }]) expect(() => asNeedsYouSocial(bad)).toThrow();
    expect(asNeedsYouSocial({ items: [{ id: "x", kind: "k", title: "t" }], partial: "no" })).toEqual({ items: [], partial: [] });
  });
});

describe("the words", () => {
  it("names a wait the way a person would", () => {
    expect(waitWords(0)).toBe("less than a minute");
    expect(waitWords(59)).toBe("less than a minute");
    expect(waitWords(60)).toBe("1 min");
    expect(waitWords(61)).toBe("2 min");
    expect(waitWords(45 * 60)).toBe("45 min");
    expect(waitWords(3600)).toBe("1 h");
    expect(waitWords(12_000)).toBe("3 h 20 min");
    expect(waitWords(86_400)).toBe("24 h");
  });
  it("says how long ago", () => {
    const now = Date.parse("2026-10-14T04:00:00Z");
    expect(agoWords("2026-10-14T03:59:50Z", now)).toBe("just now");
    expect(agoWords("2026-10-14T03:15:00Z", now)).toBe("45 min ago");
    expect(agoWords("2026-10-14T01:00:00Z", now)).toBe("3 h ago");
    expect(agoWords("2026-10-12T04:00:00Z", now)).toBe("2 days ago");
    expect(agoWords("not a date", now)).toBe("");
  });
  it("words each refusal of a follow-up, with the wait for the too-soon one", () => {
    expect(followUpRefusalText({ error: "follow_up_too_soon", retryAfterSeconds: 12_000 })).toBe("The holder was reminded in the last 24 hours. You can follow up again in 3 h 20 min.");
    expect(followUpRefusalText({ error: "follow_up_too_soon" })).toMatch(/Try again later/);
    expect(followUpRefusalText({ error: "nobody_to_follow_up" })).toMatch(/nobody to follow up/);
    expect(followUpRefusalText({ error: "status_changed" })).toMatch(/moved on/);
    expect(followUpRefusalText({ error: "some_new_code" })).toBe("some_new_code");
  });
  it("calls every holder and every status of the fixture by a name, so none reads as a code", () => {
    for (const role of ["client", "copywriter", "approver", "designer", "external"]) expect(holderTitle(role, role)).toMatch(/^Waiting on /);
    for (const s of (fixture as unknown as { statuses: string[] }).statuses) expect(statusWords(s), s).not.toBe(s);
    expect(statusWords("something_new")).toBe("something_new");
    expect(needsKindWords("proofread")).toBe("To proofread");
    expect(needsKindWords("new_kind")).toBe("new_kind");
  });
  it("links a post to the post page and a client to the conversation section of its Work tab", () => {
    expect(postHref("d-soc", "p-1")).toBe("/departments/d-soc/posts/p-1");
    expect(postHref("d s", "p/1")).toBe("/departments/d%20s/posts/p%2F1");
    expect(clientConversationHref("c-1")).toBe("/clients/c-1/work#conversation");
  });
});
