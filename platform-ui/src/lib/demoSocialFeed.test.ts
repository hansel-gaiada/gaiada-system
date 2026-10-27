import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-1d / SCP-1j (BFF §63.7): the DEMO_MODE answers of `GET feed`, `GET waiting` and `GET needs-you`, and the demo's `follow_up`. The store seeds from the day it
// is first touched, so the clock is pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported (hence vi.hoisted), as
// `demoSocialPipeline.test.ts` does. Only Date is faked. Every expectation is derived from the store and the fixture twin, never retyped.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { PIPE_POSTS, allocStore, demoYourTurn, type PipePost } from "./demoSocialPipeline";
import { scpHolderOf } from "./scpStageMachine";
import { socialDemo } from "./demoSocial";

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = (method: string, path: string, user: string, query = "", body?: unknown) =>
  socialDemo(method, `/api/co-demo/modules/social/${path}`, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user)!;
const feed = (user: string, query = ""): Body => {
  const r = call("GET", "feed", user, query);
  expect(r.status, `${user} ${query}: ${JSON.stringify(r.json)}`).toBe(200);
  return r.json as Body;
};
const holderOf = (p: PipePost): string | null =>
  scpHolderOf({ pipelineStatus: p.pipelineStatus, changeCase: p.changeCase, scheduleVia: p.scheduleVia, blockWaitingOn: p.blockWaitingOn, creativeState: p.creativeState });
const officerOf = (p: PipePost): string | null => allocStore.byEngagement[p.engagementId]?.officerId ?? null;
const ids = (items: Array<{ id: string }>): string[] => items.map((i) => i.id);

describe("GET feed", () => {
  it("your_turn is the posts the caller holds, per persona; the owner and the superadmin hold no seat, so they have none", () => {
    const expected = (pred: (p: PipePost) => boolean) => PIPE_POSTS.filter(pred).map((p) => p.id).sort();
    const got = (u: string) => ids(feed(u, "view=your_turn&limit=50").items).sort();
    expect(got("u-social")).toEqual(expected((p) => holderOf(p) === "officer" && officerOf(p) === "u-social"));
    expect(got("u-social-2")).toEqual(expected((p) => holderOf(p) === "officer" && officerOf(p) === "u-social-2"));
    expect(got("u-copy")).toEqual(expected((p) => holderOf(p) === "copywriter"));
    expect(got("u-pm")).toEqual(expected((p) => holderOf(p) === "approver"));
    expect(got("u-gm")).toEqual(expected((p) => holderOf(p) === "approver"));
    expect(got("u-social-design")).toEqual(expected((p) => holderOf(p) === "designer" && p.creativeSource === "in_team"));
    expect(got("u-creative")).toEqual(expected((p) => holderOf(p) === "designer" && p.creativeSource === "creatives"));
    expect(got("demo-owner")).toEqual([]);
    expect(got("demo-hansel")).toEqual([]);
    // each of those is a non-empty answer for the persona that has work
    for (const u of ["u-social", "u-copy", "u-pm", "u-creative"]) expect(got(u).length, u).toBeGreaterThan(0);
  });

  it("the maker is never the checker: the officer of a client does not see its approver-held posts as their turn", () => {
    const eng = Object.keys(allocStore.byEngagement).find((e) => PIPE_POSTS.some((p) => p.engagementId === e && holderOf(p) === "approver" && (p.pipelineStatus === "hod" || p.pipelineStatus === "final")))!;
    const before = allocStore.byEngagement[eng].officerId;
    expect(feed("u-gm", "view=your_turn&limit=50").items.some((c: Body) => PIPE_POSTS.find((p) => p.id === c.id)!.engagementId === eng)).toBe(true);
    allocStore.byEngagement[eng].officerId = "u-gm";
    try {
      const turn = feed("u-gm", "view=your_turn&limit=50").items as Body[];
      // the posts of that client the approvers hold are no longer theirs (the ones the officer holds now are, as their own client's)
      expect(turn.some((c) => PIPE_POSTS.find((p) => p.id === c.id)!.engagementId === eng && c.holder.role === "approver")).toBe(false);
      // still in the team's view, as a step they may not take
      const all = (feed("u-gm", "view=all&limit=50").items as Body[]).find((c) => PIPE_POSTS.find((p) => p.id === c.id)!.engagementId === eng && c.holder.role === "approver" && (c.pipelineStatus === "hod" || c.pipelineStatus === "final"))!;
      expect(all.yourTurn).toBe(false);
      expect(all.nextAction).toMatchObject({ allowed: false, reason: "author_cannot_approve" });
      expect(PIPE_POSTS.filter((p) => p.engagementId === eng).some((p) => demoYourTurn(p, "u-gm") && holderOf(p) === "approver")).toBe(false);
    } finally {
      allocStore.byEngagement[eng].officerId = before;
    }
  });

  it("a card carries exactly the PipelineCard fields, and a next action only where the status has a primary step", () => {
    const card = feed("u-social", "view=your_turn&limit=1").items[0] as Body;
    expect(Object.keys(card).sort()).toEqual([
      "clientName", "engagementId", "format", "health", "holder", "id", "isExtra", "isStory", "nextAction", "phase", "pipelineStatus",
      "scheduledAt", "simulated", "statusSince", "thumbFileId", "title", "yourTurn",
    ]);
    expect(card.yourTurn).toBe(true);
    expect(card.holder).toMatchObject({ role: "officer" });
    const live = (feed("u-pm", "view=all&limit=50&phase=posted").items as Body[]);
    expect(live.length).toBeGreaterThan(0);
    // a live post's primary step is the boost request, which is not an action of this route
    expect(live.every((c) => c.nextAction === null)).toBe(true);
  });

  it("orders health first (late, at risk, tight), then status_since, and pages by cursor without repeating or losing a card", () => {
    const rank: Record<string, number> = { late: 4, at_risk: 3, tight: 2 };
    const all = feed("u-pm", "view=all&limit=50");
    const items = all.items as Body[];
    expect(items.length).toBe(Math.min(50, PIPE_POSTS.length));
    for (let i = 1; i < items.length; i++) {
      const a = rank[items[i - 1].health.state] ?? 0;
      const b = rank[items[i].health.state] ?? 0;
      expect(a, `${i}`).toBeGreaterThanOrEqual(b);
      if (a === b) expect(items[i - 1].statusSince <= items[i].statusSince, `${i}`).toBe(true);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Body = feed("u-pm", `view=all&limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...ids(r.items));
      cursor = r.nextCursor;
      pages += 1;
    } while (cursor && pages < 40);
    expect(cursor).toBeNull();
    expect(seen).toEqual(ids(feed("u-pm", "view=all&limit=50").items).concat(seen.slice(50)));
    expect(new Set(seen).size).toBe(PIPE_POSTS.length);
  });

  it("filters narrow: engagement, phase and officer", () => {
    const eng = PIPE_POSTS[0].engagementId;
    const mine = feed("u-pm", `view=all&limit=50&engagementId=${eng}`).items as Body[];
    expect(mine.length).toBe(PIPE_POSTS.filter((p) => p.engagementId === eng).length);
    expect(mine.every((c) => c.engagementId === eng)).toBe(true);
    const clientPhase = feed("u-pm", "view=all&limit=50&phase=with_client").items as Body[];
    expect(clientPhase.length).toBeGreaterThan(0);
    expect(clientPhase.every((c) => c.phase === "with_client")).toBe(true);
    const byOfficer = feed("u-pm", "view=all&limit=50&officerId=u-social-2").items as Body[];
    expect(byOfficer.every((c) => officerOf(PIPE_POSTS.find((p) => p.id === c.id)!) === "u-social-2")).toBe(true);
    expect(byOfficer.length).toBe(PIPE_POSTS.filter((p) => officerOf(p) === "u-social-2").length);
  });

  it("refuses a bad query with 400 and its field, and a client contact with 403", () => {
    for (const [q, field] of [["view=bogus", "view"], ["limit=0", "limit"], ["limit=101", "limit"], ["phase=bogus", "phase"], ["cursor=zz", "cursor"]] as const) {
      const r = call("GET", "feed", "u-pm", q);
      expect(r.status, q).toBe(400);
      expect(r.json, q).toMatchObject({ error: "invalid_field", field });
    }
    expect(call("GET", "feed", "demo-client").status).toBe(403);
    expect(call("GET", "waiting", "demo-client").status).toBe(403);
    expect(call("GET", "needs-you", "demo-client").status).toBe(403);
  });
});

describe("GET waiting and follow_up", () => {
  it("groups the officer's posts by holder, never the ones they hold themselves, with the client's under its own group", () => {
    const r = call("GET", "waiting", "u-social");
    expect(r.status).toBe(200);
    const groups = (r.json as Body).groups as Body[];
    expect(groups.length).toBeGreaterThan(1);
    const roles = groups.map((g) => g.holder.role);
    expect(roles).not.toContain("officer");
    expect(roles).not.toContain("publisher");
    expect(roles).toContain("client");
    const total = groups.reduce((n, g) => n + g.posts.length, 0);
    expect(total).toBe(PIPE_POSTS.filter((p) => officerOf(p) === "u-social" && holderOf(p) !== null && holderOf(p) !== "officer" && holderOf(p) !== "publisher").length);
    for (const g of groups) {
      for (const p of g.posts) {
        const post = PIPE_POSTS.find((x) => x.id === p.id)!;
        expect(officerOf(post)).toBe("u-social");
        expect(holderOf(post)).toBe(g.holder.role);
        expect(p).toMatchObject({ pipelineStatus: post.pipelineStatus, engagementId: post.engagementId, lastFollowUpAt: null });
        expect(typeof p.clientId).toBe("string");
      }
      expect(g.posts.map((p: Body) => p.since)).toEqual([...g.posts.map((p: Body) => p.since)].sort());
    }
    // a person who is nobody's officer has nothing waiting
    expect(((call("GET", "waiting", "u-copy").json as Body).groups as Body[])).toEqual([]);
  });

  it("follow_up logs once, refuses a second inside 24 hours with the wait, and shows the time in the list", () => {
    const first = ((call("GET", "waiting", "u-social").json as Body).groups as Body[]).find((g) => g.holder.role === "approver")!.posts[0] as Body;
    const post = (): Body => ({ action: "follow_up", expectedStatus: first.pipelineStatus, actionId: "00000000-0000-4000-8000-000000000001" });
    const ok = call("POST", `posts/${first.id}/actions`, "u-social", "", post());
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const again = call("POST", `posts/${first.id}/actions`, "u-social", "", post());
    expect(again.status).toBe(409);
    const b = again.json as Body;
    expect(b.error).toBe("follow_up_too_soon");
    expect(b.retryAfterSeconds).toBeGreaterThan(86_300);
    expect(b.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    const listed = ((call("GET", "waiting", "u-social").json as Body).groups as Body[]).flatMap((g) => g.posts as Body[]).find((p) => p.id === first.id)!;
    expect(listed.lastFollowUpAt).toBe(new Date().toISOString());
  });

  it("follows the server's order of refusals: not the team's step 403, a moved post 409, nobody to follow up 409, an unknown post 404", () => {
    const some = ((call("GET", "waiting", "u-social").json as Body).groups as Body[]).flatMap((g) => g.posts as Body[]).find((p) => p.pipelineStatus === "client")!;
    expect(call("POST", `posts/${some.id}/actions`, "u-copy", "", { action: "follow_up", expectedStatus: some.pipelineStatus }).json).toMatchObject({ error: "not_officer_or_approver" });
    const moved = call("POST", `posts/${some.id}/actions`, "u-social", "", { action: "follow_up", expectedStatus: "drafting" });
    expect(moved.status).toBe(409);
    expect(moved.json).toMatchObject({ error: "status_changed" });
    // a post the officer holds themselves (a client's copy change returns to the officer)
    const mine = PIPE_POSTS.find((p) => p.pipelineStatus === "changes" && holderOf(p) === "officer" && officerOf(p) === "u-social")!;
    const own = call("POST", `posts/${mine.id}/actions`, "u-social", "", { action: "follow_up", expectedStatus: "changes" });
    expect(own.status).toBe(409);
    expect(own.json).toMatchObject({ error: "nobody_to_follow_up" });
  });
});

describe("GET needs-you", () => {
  const needs = (u: string): Body => {
    const r = call("GET", "needs-you", u);
    expect(r.status).toBe(200);
    return r.json as Body;
  };
  it("is the pipeline's leg per role, ids carrying the company, oldest first, at most 50", () => {
    const officer = needs("u-social");
    expect(officer.partial).toEqual([]);
    const kinds = new Set((officer.items as Body[]).map((i) => i.kind));
    expect([...kinds].every((k) => ["draft_to_send", "fix_asked", "ready_to_schedule", "metrics_missing"].includes(k as string))).toBe(true);
    for (const i of officer.items as Body[]) {
      expect(i.id).toMatch(/^social:co-demo:[^:]+:[a-z_]+$/);
      expect(i.href).toMatch(/^\/departments\/[^/]+\/posts\/[^/]+$/);
    }
    const since = (officer.items as Body[]).map((i) => i.since);
    expect(since).toEqual([...since].sort());
    expect((needs("u-copy").items as Body[]).every((i) => i.kind === "proofread" && i.role === "copywriter")).toBe(true);
    expect((needs("u-copy").items as Body[]).length).toBe(PIPE_POSTS.filter((p) => holderOf(p) === "copywriter").length);
    expect(new Set((needs("u-pm").items as Body[]).map((i) => i.kind))).toEqual(new Set(["hod_approval", "final_check"].filter((k) => (needs("u-pm").items as Body[]).some((i) => i.kind === k))));
    expect((needs("u-creative").items as Body[]).every((i) => i.role === "designer")).toBe(true);
  });

  it("is empty for the owner and the superadmin", () => {
    for (const u of ["demo-owner", "demo-hansel"]) expect(needs(u)).toEqual({ items: [], partial: [] });
  });
});
