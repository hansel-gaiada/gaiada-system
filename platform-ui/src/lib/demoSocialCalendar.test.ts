import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-3e (BFF §63.10, §59, §63.16): DEMO_MODE end to end for the Social Media calendar. The page reads `GET calendar` and the department calendar, and moves a date
// with `PATCH posts/:postId/pipeline` or `reschedule`. This drives every seeded post of the month through the demo store with the write the calendar's own rule
// (`moveRuleOf`, from the `dateMove` the demo's `GET calendar` says, as the server's does) picks, and checks the demo's write answers as that says, so the page's rule and
// the demo's writes (the server's twin) cannot drift apart. The store seeds from
// the day it is first touched, so the clock is pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported (hence vi.hoisted).
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { deptCalendarDemo } from "./demoDeptCalendar";
import { socialDemo } from "./demoSocial";
import { asDeptCalendar } from "./deptCalendar";
import { calendarWindow, holidayAwayByDay, moveRuleOf, shiftToDay, asDayItems } from "./socialCalendar";
import { newActionId } from "./socialPipeline";

const HOD = "u-pm";
const base = "/api/co-agency/modules/social";
const call = (method: string, path: string, body?: unknown, q: Record<string, string> = {}, userId: string = HOD) =>
  socialDemo(method, `${base}/${path}`, new URLSearchParams(q), body === undefined ? undefined : JSON.stringify(body), userId);
const window = calendarWindow("2026-10");
/** One month's grid, as the page asks for it. */
const monthOf = (m: string) => asDayItems(call("GET", "calendar", undefined, calendarWindow(m))?.json);
const month = () => monthOf("2026-10");
/** The seeded posts of last, this and next month: the demo's early-stage posts sit in the next cycle. */
const seeded = () => [...new Map(["2026-09", "2026-10", "2026-11"].flatMap(monthOf).map((i) => [i.postId, i])).values()];
/** The officer of a post, as the post's own read says (the write's actor: `author` and `schedule` are the officer's). */
const officerOf = (postId: string): string => ((call("GET", `posts/${postId}/pipeline`)?.json as { officer: { id: string } }).officer.id);

describe("the page's reads, through the demo", () => {
  it("answers the posts calendar for the grid's window, every client's, with a phase for each post", () => {
    const items = month();
    expect(items.length).toBeGreaterThan(5);
    expect(new Set(items.map((i) => i.clientName)).size).toBe(3);
    expect(items.every((i) => i.phase !== null)).toBe(true);
    // Across the seeded months every phase of the legend has a post to colour, so the legend can be checked against real chips in a browser.
    expect(new Set(seeded().map((i) => i.phase))).toEqual(new Set(["brief", "in_production", "with_client", "client_changes", "client_approved", "posted"]));
  });

  it("answers the Composer's list with posts that have no pipeline status", () => {
    const r = call("GET", "posts");
    expect(r?.status).toBe(200);
    expect(Array.isArray(r?.json)).toBe(true);
    for (const p of r?.json as Array<Record<string, unknown>>) expect(p.pipelineStatus ?? null).toBeNull();
  });

  it("answers the department calendar for Social Media with the company's holidays and a colleague on approved leave", () => {
    const r = deptCalendarDemo("GET", "/api/co-agency/departments/dept-4/calendar", new URLSearchParams(window), "demo-hansel");
    expect(r?.status).toBe(200);
    const by = holidayAwayByDay(asDeptCalendar(r?.json));
    const labels = Object.values(by).flat().map((n) => `${n.kind}: ${n.label}`);
    expect(labels).toContain("holiday: Nyepi (Day of Silence)");
    expect(labels).toContain("away: Komang Lestari · vacation");
  });

  it("answers the clients and the month's cycles the day's + needs", () => {
    expect(call("GET", "allocation")?.status).toBe(200);
    const cycles = call("GET", "cycles", undefined, { month: "2026-10" });
    expect(cycles?.status).toBe(200);
    expect((cycles?.json as { rows: Array<{ cycleId: string | null }> }).rows.some((r) => r.cycleId !== null)).toBe(true);
  });
});

describe("a date move, by the rule the calendar draws", () => {
  // Each status once, from the seeded month. A post that moves is moved to the same day plus 7 so the grid's window still holds it.
  const sample = () => {
    const seen = new Map<string, ReturnType<typeof month>[number]>();
    for (const it of seeded()) {
      const key = `${it.pipelineStatus}/${it.phase}`;
      if (!seen.has(key)) seen.set(key, it);
    }
    return [...seen.values()];
  };

  it("says on every item of the calendar what a date move does, and why when it cannot: live is post_is_live, the rest field_locked", () => {
    for (const it of seeded()) {
      const label = `${it.pipelineStatus}/${it.phase}`;
      if (it.pipelineStatus === "live") expect(it, label).toMatchObject({ dateMove: "locked", dateMoveRefusal: "post_is_live" });
      else if (it.dateMove === "locked") expect(it.dateMoveRefusal, label).toBe("field_locked");
      else expect(it.dateMoveRefusal, label).toBeNull();
      if (it.pipelineStatus === "approved" || it.pipelineStatus === "scheduled") expect(it.dateMove, label).toBe("reschedule");
    }
  });

  it("has a seeded post for every status the rule distinguishes", () => {
    const keys = sample().map((i) => `${i.pipelineStatus}/${i.phase}`);
    for (const k of ["drafting/brief", "approved/client_approved", "scheduled/client_approved", "client/with_client", "live/posted", "changes/client_changes"]) expect(keys, k).toContain(k);
  });

  const moved: Array<{ postId: string; at: string; kind: "edit" | "reschedule" }> = [];
  it("agrees with the rule for each seeded post: an edit goes through, Reschedule sends the post back to the client, anything else is refused with the server's code", () => {
    let edits = 0, reschedules = 0, refusals = 0;
    for (const it of sample()) {
      const rule = moveRuleOf(it);
      const next = shiftToDay(it.scheduledAt, new Date(Date.parse(`${it.day}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10));
      const label = `${it.pipelineStatus}/${it.phase} (${it.postId})`;
      const actor = officerOf(it.postId);
      if (rule.kind === "reschedule") {
        const r = call("POST", `posts/${it.postId}/actions`, { action: "reschedule", expectedStatus: it.pipelineStatus, actionId: newActionId(), at: next }, {}, actor);
        expect(r?.status, label).toBe(200);
        expect(r?.json, label).toMatchObject({ post: { pipelineStatus: "client", phase: "with_client", scheduledAt: next } });
        moved.push({ postId: it.postId, at: next, kind: "reschedule" });
        reschedules += 1;
      } else if (rule.kind === "edit") {
        const r = call("PATCH", `posts/${it.postId}/pipeline`, { expectedStatus: it.pipelineStatus, fields: { scheduledAt: next } }, {}, actor);
        expect(r?.status, label).toBe(200);
        expect(r?.json, label).toMatchObject({ post: { scheduledAt: next } });
        moved.push({ postId: it.postId, at: next, kind: "edit" });
        edits += 1;
      } else {
        const r = call("PATCH", `posts/${it.postId}/pipeline`, { expectedStatus: it.pipelineStatus, fields: { scheduledAt: next } }, {}, actor);
        expect(r?.status, label).toBe(409);
        // §63.10 names 409 `field_locked` (and `post_is_live`), but the engine's `status_in_from` step runs before the edit's own field guard, so a status outside the
        // edit action's `from` answers `invalid_transition` (the demo does the same, as the server's twin). The calendar never sends one of these (a locked post is
        // not draggable), and `refusalText` words each code, so a person is told in any case.
        expect(["field_locked", "invalid_transition", "post_is_live"], label).toContain((r?.json as { error: string }).error);
        refusals += 1;
      }
    }
    // The month holds all three kinds, so none of the branches above was skipped.
    expect(edits).toBeGreaterThan(0);
    expect(reschedules).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
  });

  it("then lists each moved post on its new day, and each rescheduled one with the client", () => {
    const now = new Map(seeded().map((i) => [i.postId, i]));
    expect(moved.length).toBeGreaterThan(1);
    for (const m of moved) {
      const it = now.get(m.postId);
      expect(it?.scheduledAt, m.postId).toBe(m.at);
      if (m.kind === "reschedule") expect(it, m.postId).toMatchObject({ pipelineStatus: "client", phase: "with_client" });
    }
  });
});
