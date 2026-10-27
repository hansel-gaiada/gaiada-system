import { describe, it, expect } from "vitest";
import {
  CLIENT_TABS, PHASE_LEGEND, asBulkResults, asCalendarItems, asCycleView, buildNewPost, bulkRefusalText, bulkSummary, clientHref, createRefusalText, cycleHighlights,
  gridRange, isCounted, isStory, itemsByDay, monthGrid, monthTitle, newUuid, parseClientTab, parseMonth, phaseToken, planSlots, postHref, shiftMonth,
  type ClientPost, type CalendarItem,
} from "./socialClient";
import { SKINS } from "./skins";
import { sidebarRows, workspaceBySlug } from "./workspaces";
import { areaFor } from "./areas";

// SCP-1k, SCP-1m: the client page's pure helpers. The server counts and decides; these only lay out and word what it answered.

const post = (over: Partial<ClientPost> = {}): ClientPost => ({
  postId: "p-1", title: "A post", status: "drafting", phase: "brief", holder: "officer", isExtra: false, format: "feed", health: null, ...over,
});

describe("the registry and the address", () => {
  const social = workspaceBySlug("social-media")!;
  const rows = [...sidebarRows(social).top, ...sidebarRows(social).work];

  it("gives the Social Media workspace a `profile` row, ungated, whose first tab is the client switcher", () => {
    const row = rows.find((r) => r.key === "profile");
    expect(row, "the profile row").toBeDefined();
    expect(row!.gate).toBeUndefined();
    expect(row!.tabs[0].href).toBe("/departments/{dept}/profile");
    expect(row!.tabs.map((t) => t.href)).not.toContain("/departments/{dept}/profile/preview");
  });

  it("is the row the Social skin's Profile pin opens, and the pin no longer waits on a ticket", () => {
    expect(SKINS.social.pinned!.find((p) => p.key === "profile")).toEqual({ kind: "row", key: "profile", row: "profile", label: "Profile", icon: "user" });
  });

  it("puts the switcher and a client's page in the department's own area, with the query left off", () => {
    expect(areaFor("/departments/d-1/profile")).toEqual({ kind: "workspace", deptId: "d-1" });
    expect(areaFor("/departments/d-1/profile/eng-9?tab=calendar&month=2026-11")).toEqual({ kind: "workspace", deptId: "d-1" });
  });

  it("offers New post and Extra post in the Create menu, and the Ask to Creatives (the registry's own link)", () => {
    expect(social.creates).toEqual(["compose-post", "new-post", "extra-post", "ask-creatives"]);
    for (const k of social.creates) expect(social.quickActions.map((a) => a.key)).toContain(k);
  });
});

describe("tabs", () => {
  it("offers Plan, Stories, Calendar, List and the Client profile, and no Feed preview until SCP-3d", () => {
    expect(CLIENT_TABS.map((t) => t.key)).toEqual(["plan", "stories", "calendar", "list", "brand"]);
  });
  it("reads ?tab= and falls back to Plan for anything the page does not have", () => {
    expect(parseClientTab("calendar")).toBe("calendar");
    expect(parseClientTab(["list", "plan"])).toBe("list");
    expect(parseClientTab("preview")).toBe("plan");
    expect(parseClientTab(undefined)).toBe("plan");
    expect(parseClientTab("")).toBe("plan");
  });
  it("builds the page's links", () => {
    expect(clientHref("d 1", "e-1")).toBe("/departments/d%201/profile/e-1");
    expect(clientHref("d-1", "e-1", "plan", { new: "extra" })).toBe("/departments/d-1/profile/e-1?tab=plan&new=extra");
    expect(postHref("d-1", "p/1")).toBe("/departments/d-1/posts/p%2F1");
  });
});

describe("counting: stories and extra posts are outside the target", () => {
  it("counts a post unless it is extra or a story; an extra story is extra", () => {
    expect(isCounted(post())).toBe(true);
    expect(isCounted(post({ format: null }))).toBe(true);
    expect(isCounted(post({ isExtra: true }))).toBe(false);
    expect(isCounted(post({ format: "story" }))).toBe(false);
    expect(isStory(post({ format: "story" }))).toBe(true);
    expect(isStory(post({ format: "story", isExtra: true }))).toBe(false);
  });

  it("places counted posts in the slots in order, empty slots after them up to the target, and the rest apart", () => {
    const posts = [
      post({ postId: "a" }), post({ postId: "s1", format: "story" }), post({ postId: "b", format: "reel" }),
      post({ postId: "x", isExtra: true }), post({ postId: "s2", format: "story", isExtra: false }),
    ];
    const plan = planSlots(posts, 5);
    expect(plan.filled.map((p) => p.postId)).toEqual(["a", "b"]);
    expect(plan.empty).toBe(3);
    expect(plan.over).toEqual([]);
    expect(plan.extras.map((p) => p.postId)).toEqual(["x"]);
    expect(plan.stories.map((p) => p.postId)).toEqual(["s1", "s2"]);
  });

  it("never lets stories or extra posts fill a slot, even when they would 'complete' the target", () => {
    const posts = [post({ postId: "a" }), post({ postId: "s", format: "story" }), post({ postId: "x", isExtra: true })];
    const plan = planSlots(posts, 3);
    expect(plan.filled).toHaveLength(1);
    expect(plan.empty).toBe(2);
  });

  it("lists counted posts past the target rather than hiding them", () => {
    const plan = planSlots([post({ postId: "a" }), post({ postId: "b" }), post({ postId: "c" })], 2);
    expect(plan.filled.map((p) => p.postId)).toEqual(["a", "b"]);
    expect(plan.over.map((p) => p.postId)).toEqual(["c"]);
    expect(plan.empty).toBe(0);
  });

  it("has no slots without a target, and none with a target of 0", () => {
    expect(planSlots([post()], null)).toMatchObject({ empty: 0, over: [] });
    expect(planSlots([post()], null).filled).toHaveLength(1);
    expect(planSlots([post({ postId: "a" })], 0)).toMatchObject({ empty: 0, filled: [] });
    expect(planSlots([post({ postId: "a" })], 0).over.map((p) => p.postId)).toEqual(["a"]);
  });

  it("highlights over counted posts only", () => {
    const late = { state: "late" as const, spareDays: -3, lateDays: 2, lateWith: "designer" as const, latestSafeHandoff: null, readyBy: "2026-10-10" };
    const risk = { ...late, state: "at_risk" as const };
    const h = cycleHighlights([
      post({ postId: "1", health: late }), post({ postId: "2", health: risk }), post({ postId: "3", phase: "with_client" }),
      post({ postId: "4", phase: "client_changes" }), post({ postId: "5", phase: "client_approved" }), post({ postId: "6", phase: "posted" }),
      post({ postId: "7", isExtra: true, phase: "with_client", health: late }), post({ postId: "8", format: "story", phase: "posted" }),
    ]);
    expect(h).toEqual({ late: 1, atRisk: 1, withClient: 1, changesAsked: 1, approvedOrLater: 2 });
  });
});

describe("parsing the server's answers", () => {
  const health = { state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: "2026-10-12", readyBy: "2026-10-12" };
  it("reads GET cycles/:cycleId/health into the cycle's posts", () => {
    const v = asCycleView({
      cycleId: "c-1", engagementId: "e-1", clientName: "Client A", month: "2026-10", deadline: "2026-10-14", readyBy: "2026-10-12", today: "2026-10-16", client: health,
      posts: [{ postId: "p-1", title: "One", status: "client", phase: "with_client", holder: "client", isExtra: false, format: "reel", health }],
    });
    expect(v).toMatchObject({ cycleId: "c-1", month: "2026-10", client: { state: "on_track" } });
    expect(v.posts[0]).toMatchObject({ postId: "p-1", phase: "with_client", holder: "client", format: "reel", isExtra: false, health: { spareDays: 3 } });
  });
  it("refuses a body that is not an answer, instead of drawing an empty grid", () => {
    expect(() => asCycleView({ cycleId: "c-1" })).toThrow();
    expect(() => asCycleView({ cycleId: "c-1", posts: [{ title: "no id" }] })).toThrow();
    expect(() => asCycleView([])).toThrow();
  });
  it("reads GET calendar, and refuses a body that is not a list", () => {
    const items = asCalendarItems({ items: [{ postId: "p-1", clientName: "A", title: "T", format: null, scheduledAt: "2026-10-03T09:00:00.000Z", pipelineStatus: "client", phase: "with_client", simulated: true }] });
    expect(items).toEqual([{ postId: "p-1", clientName: "A", title: "T", format: null, scheduledAt: "2026-10-03T09:00:00.000Z", pipelineStatus: "client", phase: "with_client", simulated: true }]);
    expect(() => asCalendarItems({})).toThrow();
    expect(() => asCalendarItems({ items: [{ title: "x" }] })).toThrow();
  });
});

describe("the calendar grid", () => {
  it("is Monday first, in whole weeks, with the month's days flagged", () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const weeks = monthGrid("2026-10");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0][0].iso).toBe("2026-09-28"); // a Monday
    expect(new Date(`${weeks[0][0].iso}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(weeks[0].map((d) => d.inMonth)).toEqual([false, false, false, true, true, true, true]);
    expect(weeks[weeks.length - 1][6].iso).toBe("2026-11-01"); // a Sunday
    expect(weeks).toHaveLength(5);
    expect(weeks.flat().filter((d) => d.inMonth)).toHaveLength(31);
  });
  it("does not pad a month that starts on a Monday and ends on a Sunday", () => {
    const weeks = monthGrid("2026-06"); // 1 June 2026 is a Monday; 30 June is a Tuesday
    expect(weeks[0][0].iso).toBe("2026-06-01");
    expect(weeks[weeks.length - 1][6].iso).toBe("2026-07-05");
    const feb = monthGrid("2027-02"); // 1 Feb 2027 is a Monday, 28 Feb a Sunday: exactly four weeks
    expect(feb).toHaveLength(4);
    expect(feb[0][0].iso).toBe("2027-02-01");
    expect(feb[3][6].iso).toBe("2027-02-28");
  });
  it("asks the server for the grid's days, never more than its 62", () => {
    expect(gridRange("2026-10")).toEqual({ from: "2026-09-28", to: "2026-11-01" });
    for (const m of ["2026-02", "2026-03", "2026-08", "2026-10"]) {
      const r = gridRange(m);
      expect((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 + 1).toBeLessThanOrEqual(42);
    }
  });
  it("moves between months across the year, and reads ?month= defensively", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(parseMonth("2026-11", "2026-10")).toBe("2026-11");
    expect(parseMonth("2026-13", "2026-10")).toBe("2026-10");
    expect(parseMonth(undefined, "2026-10")).toBe("2026-10");
    expect(monthTitle("2026-10")).toBe("October 2026");
  });
  it("groups items by day in the zone asked, in time order", () => {
    const mk = (postId: string, scheduledAt: string): CalendarItem => ({ postId, clientName: "A", title: postId, format: null, scheduledAt, pipelineStatus: "client", phase: "with_client", simulated: false });
    const by = itemsByDay([mk("late", "2026-10-03T15:00:00Z"), mk("early", "2026-10-03T08:00:00Z"), mk("next", "2026-10-04T08:00:00Z")], (iso) => iso.slice(0, 10));
    expect(by.get("2026-10-03")!.map((i) => i.postId)).toEqual(["early", "late"]);
    expect(by.get("2026-10-04")!.map((i) => i.postId)).toEqual(["next"]);
  });
  it("colours by the phase's token, with one legend entry per phase of the fixture", () => {
    expect(PHASE_LEGEND.map((p) => p.key)).toEqual(["brief", "in_production", "with_client", "client_changes", "client_approved", "posted"]);
    for (const p of PHASE_LEGEND) expect(p.token).toMatch(/^var\(--status-[a-z]+\)$/);
    expect(new Set(PHASE_LEGEND.map((p) => p.token)).size).toBe(PHASE_LEGEND.length);
    expect(phaseToken(null)).toBe("var(--status-idle)");
    expect(phaseToken("unknown")).toBe("var(--status-idle)");
  });
});

describe("creating a post: the body and the words", () => {
  const draft = { title: "  Launch day ", format: "reel", pillar: " Seasonal ", scheduledLocal: "2026-11-03T09:30", placement: ["instagram", "tiktok"], isExtra: false };
  it("builds the body of POST cycles/:cycleId/posts, with the caller's id", () => {
    const id = "6f0f9d5e-0a3c-4d2f-9e3b-1c2d3e4f5a6b";
    const r = buildNewPost(draft, id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toEqual({
      id, title: "Launch day", isExtra: false, format: "reel", pillar: "Seasonal", scheduledAt: new Date("2026-11-03T09:30").toISOString(), placement: ["instagram", "tiktok"],
    });
  });
  it("sends nulls for what was left empty, and isExtra for an extra post", () => {
    const r = buildNewPost({ ...draft, format: "", pillar: " ", scheduledLocal: "", placement: [], isExtra: true }, "id-1");
    expect(r).toEqual({ ok: true, body: { id: "id-1", title: "Launch day", isExtra: true, format: null, pillar: null, scheduledAt: null, placement: [] } });
  });
  it("names the first value outside its rule, as the server will", () => {
    expect(buildNewPost({ ...draft, title: "   " }, "i")).toMatchObject({ ok: false, field: "title" });
    expect(buildNewPost({ ...draft, title: "x".repeat(201) }, "i")).toMatchObject({ ok: false, field: "title" });
    expect(buildNewPost({ ...draft, pillar: "p".repeat(61) }, "i")).toMatchObject({ ok: false, field: "pillar" });
    expect(buildNewPost({ ...draft, scheduledLocal: "not a date" }, "i")).toMatchObject({ ok: false, field: "scheduledAt" });
  });
  it("makes v4 uuids", () => {
    expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newUuid()).not.toBe(newUuid());
  });
  it("words the officer-or-approver refusal in full, and the other codes", () => {
    expect(createRefusalText("not_officer_or_approver")).toMatch(/officer, the Social Media head, the GM, the owner or the superadmin/);
    expect(createRefusalText("cycle_not_found")).toMatch(/no longer there/);
    expect(createRefusalText("invalid_field", "title")).toMatch(/title/);
    expect(createRefusalText("invalid_field", "placement")).toMatch(/networks/);
    expect(createRefusalText("not authorized: social_post create")).toMatch(/do not have access/);
  });
});

describe("bulk: the answers and the words", () => {
  it("reads each item's result, ok or refused, with the blockers' messages", () => {
    const r = asBulkResults({
      results: [
        { postId: "a", ok: true, post: null },
        { postId: "b", ok: true, alreadyApplied: true, post: null },
        { postId: "c", ok: false, error: "incomplete_post", blockers: [{ code: "caption_missing", message: "The caption is empty." }] },
        { postId: "d", ok: false, error: "not_the_officer" },
      ],
    });
    expect(r).toEqual([
      { postId: "a", ok: true, alreadyApplied: false },
      { postId: "b", ok: true, alreadyApplied: true },
      { postId: "c", ok: false, error: "incomplete_post", field: undefined, blockers: [{ code: "caption_missing", message: "The caption is empty." }] },
      { postId: "d", ok: false, error: "not_the_officer", field: undefined, blockers: [] },
    ]);
    expect(() => asBulkResults({})).toThrow();
    expect(() => asBulkResults({ results: [{ ok: true }] })).toThrow();
  });
  it("words a refusal, with its blockers after it", () => {
    expect(bulkRefusalText({ postId: "d", ok: false, error: "not_the_officer", blockers: [] })).toMatch(/Only this client's officer/);
    expect(bulkRefusalText({ postId: "c", ok: false, error: "incomplete_post", blockers: [{ code: "x", message: "The caption is empty." }] })).toBe("The post is not complete enough to send. The caption is empty.");
    expect(bulkRefusalText({ postId: "e", ok: false, error: "something_new", blockers: [] })).toBe("something_new");
  });
  it("sums up the call in a line", () => {
    const ok = { postId: "a", ok: true as const, alreadyApplied: false };
    const no = { postId: "b", ok: false as const, error: "status_changed", blockers: [] };
    expect(bulkSummary("send_to_proofread", [ok, ok, no])).toBe("2 sent to proofread. 1 refused.");
    expect(bulkSummary("approve_copy", [ok])).toBe("1 approved.");
  });
});
