import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-3d: the demo store answers the client's feed preview and its swap, with the server's rule and the server's order of checks (BFF §63.10). The store seeds from
// the day it is first touched, so the clock is pinned to mid-month (Friday 16 October 2026) before it is imported (hence vi.hoisted). Only Date is faked.
// The invented clients: Northwind Traders (`soc-eng-1`, officer `u-social`), Saltmarsh Day Spa (`soc-eng-3`, `u-social-2`) and Harborlight Hotel (`soc-eng-4`, `u-social`).
// The tests mutate the store and run in order; each takes posts no earlier test used, and says which.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { asFeedPreview, asSwapAnswer, type FeedItem } from "./socialFeedPreview";

const call = (method: string, tail: string, body?: unknown, userId?: string) =>
  socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(), body === undefined ? undefined : JSON.stringify(body), userId);
const feed = (eng: string, userId?: string) => call("GET", `engagements/${eng}/feed-preview`, undefined, userId);
const swap = (eng: string, body: unknown, userId = "u-social") => call("POST", `engagements/${eng}/feed-preview/swap`, body, userId);
const items = (eng: string): FeedItem[] => asFeedPreview(feed(eng)?.json).items;
const at = (eng: string, id: string): FeedItem => items(eng).find((i) => i.postId === id)!;
const body = (eng: string, a: string, b: string) => ({
  postA: a, postB: b,
  expectedA: { status: at(eng, a).pipelineStatus, scheduledAt: at(eng, a).scheduledAt },
  expectedB: { status: at(eng, b).pipelineStatus, scheduledAt: at(eng, b).scheduledAt },
});

describe("GET engagements/:engagementId/feed-preview", () => {
  it("lists the client's dated posts newest first, leaves the story out, and locks the live ones", () => {
    const r = feed("soc-eng-1");
    expect(r?.status).toBe(200);
    const list = items("soc-eng-1");
    expect(list.map((i) => i.scheduledAt)).toEqual([...list.map((i) => i.scheduledAt)].sort().reverse());
    expect(list.some((i) => i.postId === "soc-post-n-3")).toBe(false); // a story is not in a feed grid
    expect(list.filter((i) => i.locked).map((i) => i.postId).sort()).toEqual(["soc-post-n-1", "soc-post-n-2", "soc-post-n-4"]);
    expect(list[0].postId).toBe("soc-post-n-15"); // the newest date
    expect((r?.json as { liveHidden: number }).liveHidden).toBe(0);
  });

  it("says what a date move would do to each post, by the fixture's rule", () => {
    const by = (id: string) => at("soc-eng-1", id);
    expect(by("soc-post-n-11")).toMatchObject({ pipelineStatus: "planned", dateMove: "edit", dateMoveRefusal: null, locked: false, thumbFileId: null, phase: "brief" });
    expect(by("soc-post-n-6")).toMatchObject({ pipelineStatus: "approved", dateMove: "reschedule", dateMoveRefusal: null });
    expect(by("soc-post-n-5")).toMatchObject({ pipelineStatus: "scheduled", dateMove: "reschedule" });
    expect(by("soc-post-n-13")).toMatchObject({ pipelineStatus: "proofread", dateMove: "locked", dateMoveRefusal: "field_locked" });
    expect(by("soc-post-n-8")).toMatchObject({ pipelineStatus: "changes", dateMove: "locked", dateMoveRefusal: "field_locked" }); // a client design change
    expect(by("soc-post-n-1")).toMatchObject({ pipelineStatus: "live", dateMove: "locked", dateMoveRefusal: "post_is_live", locked: true });
    expect(at("soc-eng-4", "soc-post-h-4")).toMatchObject({ pipelineStatus: "changes", dateMove: "edit" }); // a team copy change
    expect(at("soc-eng-4", "soc-post-h-3")).toMatchObject({ pipelineStatus: "changes", dateMove: "locked" }); // the client's copy change
  });

  it("is another client's own list, and refuses a client contact and an engagement that is not there", () => {
    expect(items("soc-eng-3").every((i) => !items("soc-eng-1").some((j) => j.postId === i.postId))).toBe(true);
    expect(feed("soc-eng-1", "demo-client")?.status).toBe(403);
    expect(feed("soc-eng-99")).toMatchObject({ status: 404, json: { error: "engagement_not_found" } });
  });
});

describe("POST engagements/:engagementId/feed-preview/swap", () => {
  it("two posts that are an edit (planned and drafting) trade their dates and stay where they are; nobody is asked (uses n-11, n-12)", () => {
    const a = at("soc-eng-1", "soc-post-n-11");
    const b = at("soc-eng-1", "soc-post-n-12");
    const r = swap("soc-eng-1", body("soc-eng-1", a.postId, b.postId));
    expect(r?.status, JSON.stringify(r?.json)).toBe(200);
    expect(asSwapAnswer(r?.json)).toEqual([
      { postId: a.postId, scheduledAt: b.scheduledAt, pipelineStatus: "planned", askedClient: false },
      { postId: b.postId, scheduledAt: a.scheduledAt, pipelineStatus: "drafting", askedClient: false },
    ]);
    expect(at("soc-eng-1", a.postId)).toMatchObject({ scheduledAt: b.scheduledAt, pipelineStatus: "planned" });
    expect(at("soc-eng-1", b.postId)).toMatchObject({ scheduledAt: a.scheduledAt, pipelineStatus: "drafting" });
    // newest first is kept
    const list = items("soc-eng-1");
    expect(list.map((i) => i.scheduledAt)).toEqual([...list.map((i) => i.scheduledAt)].sort().reverse());
  });

  it("two posts that are a reschedule (scheduled and approved) trade dates and BOTH go back to the client (uses n-5, n-6)", () => {
    const a = at("soc-eng-1", "soc-post-n-5");
    const b = at("soc-eng-1", "soc-post-n-6");
    const r = swap("soc-eng-1", body("soc-eng-1", a.postId, b.postId));
    expect(r?.status, JSON.stringify(r?.json)).toBe(200);
    expect(asSwapAnswer(r?.json)).toEqual([
      { postId: a.postId, scheduledAt: b.scheduledAt, pipelineStatus: "client", askedClient: true },
      { postId: b.postId, scheduledAt: a.scheduledAt, pipelineStatus: "client", askedClient: true },
    ]);
    expect(at("soc-eng-1", a.postId)).toMatchObject({ pipelineStatus: "client", scheduledAt: b.scheduledAt, dateMove: "locked", dateMoveRefusal: "field_locked", phase: "with_client" });
    expect(at("soc-eng-1", b.postId)).toMatchObject({ pipelineStatus: "client", scheduledAt: a.scheduledAt });
    // the post page says so too: the post is with the client again
    const page = call("GET", `posts/${a.postId}/pipeline`)?.json as { pipelineStatus: string; scheduleVia: string | null };
    expect(page).toMatchObject({ pipelineStatus: "client", scheduleVia: null });
  });

  it("an approved post with a drafting one: the approved one goes back to the client, the drafting one stays a draft (uses h-2, h-7)", () => {
    const a = at("soc-eng-4", "soc-post-h-2");
    const b = at("soc-eng-4", "soc-post-h-7");
    const r = swap("soc-eng-4", body("soc-eng-4", a.postId, b.postId));
    expect(r?.status, JSON.stringify(r?.json)).toBe(200);
    expect(asSwapAnswer(r?.json).map((p) => [p.pipelineStatus, p.askedClient])).toEqual([["client", true], ["drafting", false]]);
    expect(at("soc-eng-4", a.postId).scheduledAt).toBe(b.scheduledAt);
    expect(at("soc-eng-4", b.postId).scheduledAt).toBe(a.scheduledAt);
  });

  it("a post in proofread, a live post and a client copy change refuse the whole swap, and NEITHER post changes (uses n-13, n-1, h-3, h-9, n-14)", () => {
    const cases: Array<[string, string, string, string, string]> = [
      ["soc-eng-1", "soc-post-n-14", "soc-post-n-13", "field_locked", "soc-post-n-14"], // hod and proofread are both locked: the first one named is answered
      ["soc-eng-1", "soc-post-n-13", "soc-post-n-1", "field_locked", "soc-post-n-13"],
      ["soc-eng-4", "soc-post-h-9", "soc-post-h-3", "field_locked", "soc-post-h-3"],
    ];
    for (const [eng, a, b, code, who] of cases) {
      const before = [at(eng, a), at(eng, b)];
      const r = swap(eng, body(eng, a, b));
      expect(r?.status, `${a}/${b}`).toBe(409);
      expect((r?.json as { error: string }).error, `${a}/${b}`).toBe(code);
      expect((r?.json as { detail: { postId: string } }).detail.postId, `${a}/${b}`).toBe(who);
      expect([at(eng, a), at(eng, b)]).toEqual(before);
    }
    // a live post beside a movable one: post_is_live, and the movable one is untouched
    const keep = at("soc-eng-4", "soc-post-h-9");
    const live = swap("soc-eng-4", body("soc-eng-4", "soc-post-h-9", "soc-post-h-1"));
    expect(live?.status).toBe(409);
    expect((live?.json as { error: string }).error).toBe("post_is_live");
    expect(at("soc-eng-4", "soc-post-h-9")).toEqual(keep);
  });

  it("puts the first post back when the second is refused by the runner: a publisher schedule needs `cancel`, which the officer lacks (uses n-12, n-9)", () => {
    const a = at("soc-eng-1", "soc-post-n-12");
    const b = at("soc-eng-1", "soc-post-n-9");
    expect(b.dateMove).toBe("reschedule");
    const r = swap("soc-eng-1", body("soc-eng-1", a.postId, b.postId));
    expect(r?.status).toBe(403);
    expect((r?.json as { error: string }).error).toBe("cancel_required");
    expect(at("soc-eng-1", a.postId)).toEqual(a); // the edit that was applied first is undone
    expect(at("soc-eng-1", b.postId)).toEqual(b);
    // the superadmin holds `cancel`, and the same swap goes through
    const ok = swap("soc-eng-1", body("soc-eng-1", a.postId, b.postId), "demo-hansel");
    expect(ok?.status, JSON.stringify(ok?.json)).toBe(200);
    expect(at("soc-eng-1", a.postId).scheduledAt).toBe(b.scheduledAt);
  });

  it("a stale step or date is 409 status_changed and nothing changes (uses n-15, n-10)", () => {
    const a = at("soc-eng-1", "soc-post-n-15");
    const b = at("soc-eng-1", "soc-post-n-10");
    const good = body("soc-eng-1", a.postId, b.postId);
    const staleStep = swap("soc-eng-1", { ...good, expectedA: { ...good.expectedA, status: "drafting" } });
    expect(staleStep?.status).toBe(409);
    expect((staleStep?.json as { error: string }).error).toBe("status_changed");
    const staleDate = swap("soc-eng-1", { ...good, expectedB: { ...good.expectedB, scheduledAt: "2026-12-01T09:30:00.000Z" } });
    expect(staleDate?.status).toBe(409);
    expect((staleDate?.json as { error: string; detail: { postId: string } })).toMatchObject({ error: "status_changed", detail: { postId: b.postId } });
    expect(at("soc-eng-1", a.postId)).toEqual(a);
    expect(at("soc-eng-1", b.postId)).toEqual(b);
  });

  it("is answered in the server's order: the officer's gate before the body, then the body, then the posts", () => {
    // not this client's officer (u-social-2 is the spa's), the spa's own officer on Northwind's page, a client contact: 403 whatever the body
    for (const who of ["u-social-2", "u-pm", "demo-client"]) {
      expect(swap("soc-eng-1", {}, who)?.status, who).toBe(403);
    }
    expect(swap("soc-eng-1", {}, "u-social-2")).toMatchObject({ status: 403, json: { error: "not_the_officer" } });
    expect(swap("soc-eng-99", {})).toMatchObject({ status: 404, json: { error: "engagement_not_found" } });
    const f = (b: unknown) => (swap("soc-eng-1", b)?.json as { error: string; field?: string });
    expect(f({})).toEqual({ error: "missing_field", field: "postA" });
    expect(f({ postA: "soc-post-n-11" })).toEqual({ error: "missing_field", field: "postB" });
    expect(f({ postA: "soc post!", postB: "soc-post-n-11" })).toEqual({ error: "invalid_field", field: "postA" });
    const exp = { status: "planned", scheduledAt: "2026-11-04T09:30:00.000Z" };
    expect(f({ postA: "soc-post-n-11", postB: "soc-post-n-11", expectedA: exp, expectedB: exp })).toEqual({ error: "invalid_field", field: "postB" });
    expect(f({ postA: "soc-post-n-11", postB: "soc-post-n-14", expectedA: { status: "bogus", scheduledAt: exp.scheduledAt }, expectedB: exp })).toEqual({ error: "invalid_field", field: "expectedA" });
    // another client's post, and one that is not there, are 404
    expect(swap("soc-eng-1", { postA: "soc-post-n-11", postB: "soc-post-s-4", expectedA: exp, expectedB: exp })).toMatchObject({ status: 404, json: { error: "post_not_found" } });
    expect(swap("soc-eng-1", { postA: "soc-post-n-11", postB: "soc-post-zzz", expectedA: exp, expectedB: exp })).toMatchObject({ status: 404, json: { error: "post_not_found" } });
  });

  it("the superadmin passes the officer's gate on any client, and the lock rule still applies (s-4 and s-5 are at design: locked)", () => {
    const r = swap("soc-eng-3", body("soc-eng-3", "soc-post-s-4", "soc-post-s-5"), "demo-hansel");
    expect(r?.status).toBe(409);
    expect((r?.json as { error: string }).error).toBe("field_locked");
  });
});

// SCP-Sg: the live feed read back, from the demo's metrics store and accounts.
describe("the live feed read back (SCP-Sg)", () => {
  it("answers a live post's address, reach and the snapshots' mark; a post that is not live answers nulls", () => {
    const list = items("soc-eng-1");
    const live = list.filter((i) => i.locked);
    expect(live.length).toBeGreaterThan(0);
    for (const i of live) {
      expect(i.liveUrl, i.postId).toMatch(/^https:\/\/example\.com\//);
      expect(typeof i.reach, i.postId).toBe("number");
      expect(i.reachSource, i.postId).not.toBeNull();
    }
    for (const i of list.filter((x) => !x.locked)) expect(i).toMatchObject({ liveUrl: null, reach: null, reachSource: null });
  });

  it("gives a simulated post a simulated.invalid address and the simulated mark (the hotel's live post)", () => {
    const sim = items("soc-eng-4").filter((i) => i.locked && i.simulated);
    expect(sim.length).toBeGreaterThan(0);
    for (const i of sim) {
      expect(i.liveUrl).toMatch(/^https:\/\/simulated\.invalid\//);
      expect(i.reachSource).toBe("simulated");
    }
  });

  it("answers the client's last sync (the hour before the pinned clock), the same value as the accounts read", () => {
    for (const eng of ["soc-eng-1", "soc-eng-3", "soc-eng-4"]) {
      expect(asFeedPreview(feed(eng)?.json).lastSyncedAt, eng).toBe("2026-10-16T03:00:00.000Z");
    }
  });
});
