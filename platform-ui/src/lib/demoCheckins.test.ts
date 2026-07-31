import { describe, it, expect } from "vitest";
import { checkinsDemo } from "./demoCheckins";
import type { CheckinToday, CheckinHistory, CheckinSubmitResult } from "./checkins";

const DAY_MS = 86_400_000;
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function addDaysIso(iso: string, n: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

function call(method: string, path: string, query: Record<string, string> = {}, body?: unknown, userId = "demo-hansel") {
  return checkinsDemo(method, path, new URLSearchParams(query), body !== undefined ? JSON.stringify(body) : undefined, userId);
}

describe("demoCheckins — checkinsDemo (DEMO_MODE fixtures, TR-10/TR-38)", () => {
  it("returns null for a path it doesn't own, so the dispatch chain can fall through", () => {
    expect(call("GET", "/api/co-agency/pm/tasks")).toBeNull();
    expect(call("GET", "/api/co-agency/checkins/compliance")).toBeNull(); // deliberately unmodeled
  });

  it("GET /checkins/today returns a live draft, not-yet-submitted, for a fresh user", () => {
    const res = call("GET", "/api/co-agency/checkins/today", {}, undefined, "fresh-user-1");
    expect(res?.status).toBe(200);
    const today = res!.json as CheckinToday;
    expect(today.date).toBe(todayIso());
    expect(today.alreadySubmitted).toBe(false);
    expect(today.existing).toBeNull();
    expect(today.draft.summaryText.length).toBeGreaterThan(0);
  });

  it("POST /checkins rejects an empty summary", () => {
    const res = call("POST", "/api/co-agency/checkins", {}, { summary: "   " }, "fresh-user-2");
    expect(res?.status).toBe(400);
  });

  it("POST /checkins rejects a date that isn't today or yesterday", () => {
    const res = call("POST", "/api/co-agency/checkins", {}, { date: "2020-01-01", summary: "did stuff" }, "fresh-user-3");
    expect(res?.status).toBe(400);
  });

  it("submit -> today reads back as already submitted, with the same summary (stateful, same process)", () => {
    const userId = "fresh-user-4";
    const submit = call("POST", "/api/co-agency/checkins", {}, { summary: "Shipped the onboarding flow." }, userId);
    expect(submit?.status).toBe(200);
    const result = submit!.json as CheckinSubmitResult;
    expect(result.status).toBe("submitted");
    expect(result.summary).toBe("Shipped the onboarding flow.");

    const today = call("GET", "/api/co-agency/checkins/today", {}, undefined, userId)!.json as CheckinToday;
    expect(today.alreadySubmitted).toBe(true);
    expect(today.existing?.summary).toBe("Shipped the onboarding flow.");
    expect(today.existing?.status).toBe("submitted");
  });

  it("re-submitting the same day (confirm-without-editing) upserts rather than erroring", () => {
    const userId = "fresh-user-5";
    call("POST", "/api/co-agency/checkins", {}, { summary: "first pass" }, userId);
    const second = call("POST", "/api/co-agency/checkins", {}, { summary: "first pass, corrected typo" }, userId);
    expect(second?.status).toBe(200);
    const today = call("GET", "/api/co-agency/checkins/today", {}, undefined, userId)!.json as CheckinToday;
    expect(today.existing?.summary).toBe("first pass, corrected typo");
  });

  it("GET /checkins history exercises submitted/missed/excused from the seed window, and omits not-expected days entirely", () => {
    const userId = "fresh-user-6";
    // Force the seed to populate by touching /today first.
    call("GET", "/api/co-agency/checkins/today", {}, undefined, userId);
    const from = addDaysIso(todayIso(), -45);
    const to = addDaysIso(todayIso(), -1);
    const res = call("GET", "/api/co-agency/checkins", { from, to }, undefined, userId);
    expect(res?.status).toBe(200);
    const history = res!.json as CheckinHistory;
    const statuses = new Set(history.checkins.map((c) => c.status));
    expect(statuses.has("submitted")).toBe(true);
    expect(statuses.has("auto_missed")).toBe(true);
    expect(statuses.has("excused")).toBe(true);
    // The history array only ever contains days that HAVE a row — weekends/the seeded holiday
    // never appear as a fabricated "missed" entry (§5.3's guard, mirrored honestly in the fixture).
    for (const c of history.checkins) expect(["submitted", "auto_missed", "excused"]).toContain(c.status);
  });

  // The real controller's 409 (submit-against-an-already-excused-day) needs an excused row that
  // falls on TODAY or YESTERDAY — this demo fixture's seeded excused day deliberately sits well in
  // the past (EXCUSED_OFFSET = -6), same as the real world's excuse workflow (a manager excuses a
  // day well after the fact, not same/next day), so the 409 branch genuinely can't be exercised
  // through these fixtures without also modeling the manager `/checkins/:id/excuse` action — out of
  // this demo module's scope (see its header comment). What IS tested here: an excused row is
  // stable across repeated seeding/reads, never silently overwritten or dropped.
  it("an excused day in the seed window stays excused (with a reason) across repeated reads", () => {
    const userId = "fresh-user-7";
    call("GET", "/api/co-agency/checkins/today", {}, undefined, userId); // triggers the seed walk
    const from = addDaysIso(todayIso(), -45);
    const to = addDaysIso(todayIso(), -1);
    const first = call("GET", "/api/co-agency/checkins", { from, to }, undefined, userId)!.json as CheckinHistory;
    const excusedDay = first.checkins.find((c) => c.status === "excused");
    expect(excusedDay).toBeTruthy();
    expect(excusedDay?.excusedReason).toBeTruthy();

    const second = call("GET", "/api/co-agency/checkins", { from, to }, undefined, userId)!.json as CheckinHistory;
    expect(second.checkins.find((c) => c.status === "excused")?.date).toBe(excusedDay?.date);
  });

  it("history defaults to the caller's own userId when none is passed in the query", () => {
    const userId = "fresh-user-8";
    call("GET", "/api/co-agency/checkins/today", {}, undefined, userId);
    const from = addDaysIso(todayIso(), -45);
    const to = addDaysIso(todayIso(), -1);
    const res = call("GET", "/api/co-agency/checkins", { from, to }, undefined, userId)!.json as CheckinHistory;
    expect(res.userId).toBe(userId);
  });
});
