import { describe, it, expect } from "vitest";
import fixture from "./scpStageMachine.json";
import { SCP_PHASES, SCP_STATUSES } from "./scpStageMachine";
import { asDeptCalendar } from "./deptCalendar";
import { dateMoveForPost } from "./socialFeedPreview";
import { PHASE_LEGEND, PHASE_TOKEN, monthGrid, phaseToken, shiftMonth } from "./socialClient";
import type { AllocationRow } from "./socialAllocation";
import type { CycleTable } from "./socialCycles";
import {
  CALENDAR_WEEKDAYS, COMPOSER_LEGEND, asComposerEntries, asDayItems, calendarHref, calendarWindow, composerInWindow, dayOfIso, defaultPostIso, holidayAwayByDay,
  hrLegNotes, movedWords, moveRuleOf, placeItem, planClients, rescheduleWarning, shiftToDay, timeOfIso,
} from "./socialCalendar";

// SCP-3e (BFF §63.10, §59; plan §8 row 3e): the Social Media calendar's pure parts. The display zone is Asia/Singapore (+08:00, no daylight saving) unless
// NEXT_PUBLIC_DISPLAY_TZ says otherwise, so every instant below is written in UTC and read back in that zone.

describe("the Monday-first month grid", () => {
  const isos = (m: string) => monthGrid(m).flat().map((d) => d.iso);
  const shape = (m: string) => {
    const g = monthGrid(m);
    return { weeks: g.length, first: g[0][0].iso, last: g[g.length - 1][6].iso, inMonth: g.flat().filter((d) => d.inMonth).length };
  };

  it("labels the week Monday to Sunday", () => {
    expect([...CALENDAR_WEEKDAYS]).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("starts a month that begins on a Sunday on the Monday six days before it, with that Sunday in the last column", () => {
    // 1 February 2026 is a Sunday.
    const g = monthGrid("2026-02");
    expect(shape("2026-02")).toEqual({ weeks: 5, first: "2026-01-26", last: "2026-03-01", inMonth: 28 });
    expect(g[0].map((d) => d.inMonth)).toEqual([false, false, false, false, false, false, true]);
    expect(g[0][6].iso).toBe("2026-02-01");
    expect(new Date(`${g[0][0].iso}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  it("starts a month that begins on a Monday on that Monday, with nothing before it", () => {
    // 1 June 2026 is a Monday.
    expect(monthGrid("2026-06")[0][0]).toEqual({ iso: "2026-06-01", inMonth: true });
    expect(shape("2026-06")).toEqual({ weeks: 5, first: "2026-06-01", last: "2026-07-05", inMonth: 30 });
  });

  it("has a 29-day February in a leap year, and a 28-day one in the year after", () => {
    // 29 February 2028 is a Tuesday; the grid runs from Monday 31 January to Sunday 5 March.
    expect(shape("2028-02")).toEqual({ weeks: 5, first: "2028-01-31", last: "2028-03-05", inMonth: 29 });
    expect(isos("2028-02")).toContain("2028-02-29");
    expect(isos("2029-02")).not.toContain("2029-02-29");
    expect(shape("2029-02").inMonth).toBe(28);
  });

  it("crosses the year turn in both directions, with the days of the neighbouring year shown dimmed", () => {
    expect(shape("2026-12")).toEqual({ weeks: 5, first: "2026-11-30", last: "2027-01-03", inMonth: 31 });
    expect(shape("2027-01")).toEqual({ weeks: 5, first: "2026-12-28", last: "2027-01-31", inMonth: 31 });
    expect(monthGrid("2026-12").flat().find((d) => d.iso === "2027-01-01")?.inMonth).toBe(false);
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
  });

  it("is whole weeks of seven, never more than six, for every month of a four-year span", () => {
    for (let i = 0; i < 48; i += 1) {
      const m = shiftMonth("2026-01", i);
      const g = monthGrid(m);
      expect(g.every((w) => w.length === 7), m).toBe(true);
      expect(g.length, m).toBeGreaterThanOrEqual(4);
      expect(g.length, m).toBeLessThanOrEqual(6);
      expect(new Date(`${g[0][0].iso}T00:00:00Z`).getUTCDay(), m).toBe(1);
    }
  });

  it("asks both servers for the grid's days: at most 42, the department calendar's longest window and inside the posts calendar's 62", () => {
    for (let i = 0; i < 48; i += 1) {
      const w = calendarWindow(shiftMonth("2026-01", i));
      const days = (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(42);
    }
    expect(calendarWindow("2026-10")).toEqual({ from: "2026-09-28", to: "2026-11-01" });
  });
});

describe("the legend: a phase is its status token, as the status families mean it", () => {
  it("has one entry per phase of the fixture, in its order, and the Composer's own entry beside them", () => {
    expect(PHASE_LEGEND.map((p) => p.label)).toEqual(["Brief", "In production", "With client", "Client changes", "Client approved", "Posted"]);
    expect(PHASE_LEGEND.map((p) => p.key)).toEqual(SCP_PHASES.map((p) => p.key));
    expect(COMPOSER_LEGEND.label).toBe("Composer post");
  });

  it("colours each phase with a status token, each one different, and never a literal", () => {
    expect(PHASE_TOKEN).toEqual({
      brief: "var(--status-idle)", in_production: "var(--status-progress)", with_client: "var(--status-info)",
      client_changes: "var(--status-warning)", client_approved: "var(--status-ok)", posted: "var(--status-neutral)",
    });
    expect(new Set(Object.values(PHASE_TOKEN)).size).toBe(SCP_PHASES.length);
    for (const p of SCP_PHASES) expect(phaseToken(p.key), p.key).toMatch(/^var\(--status-[a-z]+\)$/);
    expect(phaseToken(null)).toBe("var(--status-idle)");
  });

  it("maps every status of the fixture to a phase that has a colour", () => {
    const phaseOf = fixture.phaseOf as Record<string, string>;
    for (const s of SCP_STATUSES) {
      if (s === "changes") continue; // a change case names its phase
      expect(PHASE_TOKEN[phaseOf[s]], s).toBeDefined();
    }
    for (const c of fixture.changeCases) expect(PHASE_TOKEN[c.phase], c.key).toBeDefined();
  });
});

describe("the date-move rule: the server's answer, worded", () => {
  const rule = (pipelineStatus: string, dateMove: "edit" | "reschedule" | "locked", dateMoveRefusal: "post_is_live" | "field_locked" | null = null) =>
    moveRuleOf({ pipelineStatus, dateMove, dateMoveRefusal });
  const phaseOf = fixture.phaseOf as Record<string, string>;

  it("takes the server's word: an edit is an edit and a reschedule is a reschedule, whatever the status", () => {
    expect(rule("planned", "edit")).toEqual({ kind: "edit" });
    expect(rule("changes", "edit")).toEqual({ kind: "edit" });
    expect(rule("approved", "reschedule")).toEqual({ kind: "reschedule" });
    expect(rule("scheduled", "reschedule")).toEqual({ kind: "reschedule" });
  });

  it("locks a post the server locked, with the reason in words (`field_locked`, `post_is_live`)", () => {
    const live = rule("live", "locked", "post_is_live");
    expect(live).toEqual({ kind: "locked", why: "The post is live, so its date cannot change." });
    expect(rule("client", "locked", "field_locked")).toEqual({ kind: "locked", why: "The client is looking at it." });
    const kinds = ["proofread", "hod", "design", "final", "blocked"] as const;
    for (const s of kinds) {
      const r = rule(s, "locked", "field_locked");
      expect(r.kind, s).toBe("locked");
      expect(r.kind === "locked" && r.why.length, s).toBeGreaterThan(10);
    }
  });

  it("words a locked change: the date stays as the client saw it, and Reschedule asks again after the next approval", () => {
    const r = rule("changes", "locked", "field_locked");
    expect(r.kind === "locked" && r.why).toMatch(/design change or a change the client asked for/);
    expect(r.kind === "locked" && r.why).toMatch(/Reschedule/);
  });

  it("never guesses: a body without `dateMove` is refused, not drawn", () => {
    expect(() => asDayItems({ items: [{ postId: "p", scheduledAt: "2026-10-20T01:30:00.000Z", pipelineStatus: "changes", phase: "in_production" }] })).toThrow(/dateMove/);
    expect(() => asDayItems({ items: [{ postId: "p", scheduledAt: "2026-10-20T01:30:00.000Z", pipelineStatus: "planned", dateMove: "maybe" }] })).toThrow();
  });

  it("reads a locked item without a stated refusal as field_locked, and a movable one as having none", () => {
    const at = "2026-10-20T01:30:00.000Z";
    const [a, b, c] = asDayItems({ items: [
      { postId: "a", scheduledAt: at, pipelineStatus: "hod", dateMove: "locked" },
      { postId: "b", scheduledAt: at, pipelineStatus: "live", dateMove: "locked", dateMoveRefusal: "post_is_live" },
      { postId: "c", scheduledAt: at, pipelineStatus: "planned", dateMove: "edit", dateMoveRefusal: "field_locked" },
    ] });
    expect([a.dateMoveRefusal, b.dateMoveRefusal, c.dateMoveRefusal]).toEqual(["field_locked", "post_is_live", null]);
  });

  it("agrees with the demo's twin of the fixture rule for every status and change case, so the words and the drag cannot disagree", () => {
    const cases: Array<[string, string | null]> = [...SCP_STATUSES.filter((s) => s !== "changes").map((s): [string, string | null] => [s, null]),
      ...fixture.changeCases.map((c): [string, string | null] => ["changes", c.key])];
    const kinds = new Map<string, string>();
    for (const [status, changeCase] of cases) {
      const m = dateMoveForPost({ status, changeCase });
      const r = moveRuleOf({ pipelineStatus: status, dateMove: m.move, dateMoveRefusal: m.refusal });
      kinds.set(`${status}${changeCase ? `/${changeCase}` : ""}`, r.kind);
      expect(r.kind, status).toBe(m.move);
    }
    const movable = [...kinds].filter(([, k]) => k !== "locked").map(([k]) => k);
    expect(movable.sort()).toEqual(["approved", "changes/copywriter_copy", "changes/final_copy", "changes/hod_copy", "drafting", "planned", "scheduled"].sort());
    expect(phaseOf.live).toBe("posted");
  });

  it("follows the fixture's own date_moves rule in prose, so a change to the machine breaks this test", () => {
    const rules = fixture.systemRules as Array<{ rule: string; then: string }>;
    const then = rules.find((r) => r.rule === "date_moves")?.then ?? "";
    expect(then).toContain("planned, drafting and a team copy changes case: an edit");
    expect(then).toContain("approved and scheduled: reschedule, which asks the client again");
    expect(then).toContain("proofread, hod, design, final, client, blocked and the client copy changes case: 409 field_locked");
    expect(then).toContain("live: 409 post_is_live");
  });
});

describe("moving a post to another day", () => {
  it("keeps the time of day in the display zone", () => {
    // 09:30 on the 20th in Singapore is 01:30 UTC.
    expect(shiftToDay("2026-10-20T01:30:00.000Z", "2026-10-23")).toBe("2026-10-23T01:30:00.000Z");
    // 23:30 on the 20th in Singapore is 15:30 UTC the same UTC day; the move keeps 23:30 on the new day.
    expect(shiftToDay("2026-10-20T15:30:00.000Z", "2026-10-25")).toBe("2026-10-25T15:30:00.000Z");
  });

  it("reads the day and the time in the display zone, not in UTC", () => {
    expect(dayOfIso("2026-10-20T20:00:00.000Z")).toBe("2026-10-21");
    expect(timeOfIso("2026-10-20T20:00:00.000Z")).toBe("04:00");
    expect(placeItem({ postId: "p", clientName: "Brand Alpha", title: "T", format: "feed", scheduledAt: "2026-10-20T01:30:00.000Z", pipelineStatus: "drafting", phase: "brief", simulated: false, dateMove: "edit", dateMoveRefusal: null }))
      .toMatchObject({ day: "2026-10-20", time: "09:30" });
  });

  it("says in words that the client will be asked again, and that a scheduled post is unscheduled first", () => {
    const next = "2026-10-23T01:30:00.000Z";
    const approved = rescheduleWarning({ title: "Harvest teaser", pipelineStatus: "approved" }, next);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toContain("The client will be asked to approve Fri 23 Oct 2026 at 09:30 again");
    expect(approved[0]).toContain("every network");
    const scheduled = rescheduleWarning({ title: "Harvest teaser", pipelineStatus: "scheduled" }, next);
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]).toMatch(/unscheduled first.*cancelled/);
  });

  it("says the outcome: a plain move, or a move that sends the post back to the client", () => {
    const next = "2026-10-23T01:30:00.000Z";
    expect(movedWords({ title: "Teaser" }, { kind: "edit" }, next)).toBe('Moved "Teaser" to Fri 23 Oct 2026 at 09:30.');
    expect(movedWords({ title: "Teaser" }, { kind: "reschedule" }, next)).toBe('Moved "Teaser" to Fri 23 Oct 2026 at 09:30. The client will be asked to approve it again.');
  });
});

describe("GET calendar, GET posts and the pipeline's own post list", () => {
  it("places each item on its day and time, and refuses a body that is not a list", () => {
    const items = asDayItems({ items: [{ postId: "p-1", clientName: "Brand Alpha", title: "T", format: "feed", scheduledAt: "2026-10-20T01:30:00.000Z", pipelineStatus: "client", phase: "with_client", simulated: true, dateMove: "locked", dateMoveRefusal: "field_locked" }] });
    expect(items).toEqual([expect.objectContaining({ postId: "p-1", day: "2026-10-20", time: "09:30", simulated: true })]);
    expect(() => asDayItems({ nope: 1 })).toThrow();
  });

  it("keeps the Composer's own dated posts and drops pipeline posts, undated ones and rows that are not posts", () => {
    const rows = [
      { id: "c-1", title: "Weekly promo", status: "approved", engagementId: "e-1", scheduledAt: "2026-10-27T01:00:00.000Z", pipelineStatus: null },
      { id: "c-2", title: "No pipeline field", status: "draft", engagementId: "e-1", scheduledAt: "2026-10-05T01:00:00.000Z" },
      { id: "pp-1", title: "A pipeline post", status: "draft", engagementId: "e-1", scheduledAt: "2026-10-06T01:00:00.000Z", pipelineStatus: "planned" },
      { id: "c-3", title: "Undated", status: "draft", engagementId: "e-1", scheduledAt: null, pipelineStatus: null },
      { title: "No id" },
      "nope",
    ];
    const entries = asComposerEntries(rows);
    expect(entries.map((e) => e.postId)).toEqual(["c-2", "c-1"]);
    expect(entries[1]).toMatchObject({ day: "2026-10-27", time: "09:00" });
    expect(() => asComposerEntries({ posts: [] })).toThrow();
  });

  it("keeps the window and the client filter", () => {
    const entries = asComposerEntries([
      { id: "a", title: "A", engagementId: "e-1", scheduledAt: "2026-10-05T01:00:00.000Z" },
      { id: "b", title: "B", engagementId: "e-2", scheduledAt: "2026-10-06T01:00:00.000Z" },
      { id: "c", title: "C", engagementId: "e-1", scheduledAt: "2026-12-06T01:00:00.000Z" },
    ]);
    const w = calendarWindow("2026-10");
    expect(composerInWindow(entries, w, null).map((e) => e.postId)).toEqual(["a", "b"]);
    expect(composerInWindow(entries, w, "e-1").map((e) => e.postId)).toEqual(["a"]);
  });
});

describe("holidays and approved leave from the department calendar (§59)", () => {
  const leg = (items: unknown[]) => ({ included: true, items });
  const cal = (over: Record<string, unknown> = {}) => asDeptCalendar({
    unit: { id: "d-soc", name: "Social Media" }, from: "2026-09-28", to: "2026-11-01",
    holidays: leg([{ day: "2026-10-09", name: "Nyepi", kind: "public" }]),
    away: leg([{ userId: "u-1", name: "Maya Putri", startsOn: "2026-10-13", endsOn: "2026-10-14", leaveType: "vacation" }]),
    deadlines: leg([{ milestoneId: "m-1", name: "Staging", dueDate: "2026-10-21", projectId: "p-1", projectName: "Site" }]),
    events: leg([{ id: "ev-1", title: "Offsite", startsAt: null, endsAt: null, startsOn: "2026-10-22", endsOn: "2026-10-22", visibility: "company", unitNodeId: null }]),
    ...over,
  });

  it("draws the two HR legs by day, away colleagues on each day of their leave, and leaves milestones and events to the Schedule page", () => {
    const by = holidayAwayByDay(cal());
    expect(by["2026-10-09"]).toEqual([expect.objectContaining({ kind: "holiday", label: "Nyepi", detail: "Public holiday" })]);
    expect(by["2026-10-13"]).toEqual([expect.objectContaining({ kind: "away", label: "Maya Putri · vacation" })]);
    expect(by["2026-10-14"]).toEqual([expect.objectContaining({ kind: "away" })]);
    expect(by["2026-10-21"]).toBeUndefined();
    expect(by["2026-10-22"]).toBeUndefined();
  });

  it("draws nothing for a leg that did not load, and says so in one line each (an empty list is a claim)", () => {
    const c = cal({ holidays: { included: false, reason: "read_failed" }, away: { included: false, reason: "module_off" } });
    expect(holidayAwayByDay(c)).toEqual({});
    expect(hrLegNotes(c)).toEqual(["Holidays could not be loaded.", "The HR module is off for this company, so who is away is not shown."]);
  });

  it("shares one line when the HR module is off for both legs, and says nothing about the legs the page does not draw", () => {
    const c = cal({ holidays: { included: false, reason: "module_off" }, away: { included: false, reason: "module_off" }, deadlines: { included: false, reason: "read_failed" } });
    expect(hrLegNotes(c)).toEqual(["The HR module is off for this company, so holidays and who is away are not shown."]);
  });

  it("is silent when both legs loaded, even when they are empty", () => {
    const c = cal({ holidays: leg([]), away: leg([]) });
    expect(holidayAwayByDay(c)).toEqual({});
    expect(hrLegNotes(c)).toEqual([]);
  });

  it("says a leg was cut at 200", () => {
    const c = cal({ away: { included: true, items: [], truncated: true } });
    expect(hrLegNotes(c)).toEqual(["Only the first 200 leave entries are shown, so some may be missing."]);
  });
});

describe("the page's address", () => {
  it("is the bare address for the current month, and carries the month and the client otherwise", () => {
    expect(calendarHref("d-soc", "2026-10", "2026-10-16")).toBe("/departments/d-soc/calendar");
    expect(calendarHref("d-soc", "2026-11", "2026-10-16")).toBe("/departments/d-soc/calendar?month=2026-11");
    expect(calendarHref("d-soc", "2026-11", "2026-10-16", "e-alpha")).toBe("/departments/d-soc/calendar?month=2026-11&engagementId=e-alpha");
    expect(calendarHref("d-soc", "2026-10", "2026-10-16", "e-alpha")).toBe("/departments/d-soc/calendar?engagementId=e-alpha");
  });
});

describe("planning a post on a day", () => {
  const row = (over: Partial<AllocationRow>): AllocationRow => ({
    engagementId: "e-alpha", clientId: "c-alpha", clientName: "Brand Alpha", status: "active", officer: { id: "u-2", name: "Sam Officer" }, postsPerCycle: 5,
    creativeSource: "creatives", deliveryBatch: "A", reportFormat: "email", reportDueDay: 5, platforms: ["instagram"], formats: ["feed"], defaultPostTime: "09:30",
    stepEstimates: {}, thisCycle: { cycleId: "cy-now", month: "2026-10", target: 5, counted: 1, extra: 0, stories: 0 }, canPlan: false, ...over,
  });
  const table = (rows: Array<{ engagementId: string; cycleId: string | null }>): CycleTable => ({
    month: "2026-11", bufferWorkingDays: 3, holidaysKnown: true, canPlan: false,
    rows: rows.map((r) => ({ ...r, clientName: "", officer: null, deliveryBatch: null, deadline: null, readyBy: null, prefill: { deadline: null, batch: null }, target: null, counts: {} as never, health: null })),
  });

  it("puts the viewer's own clients first, then by name", () => {
    const out = planClients([row({ engagementId: "e-z", clientName: "Zed" }), row({ engagementId: "e-b", clientName: "Bay", officer: { id: "u-me", name: "Me" } }), row({ engagementId: "e-a", clientName: "Ant" })], null, "2026-10", "u-me");
    expect(out.map((c) => c.clientName)).toEqual(["Bay", "Ant", "Zed"]);
    expect(out[0].mine).toBe(true);
  });

  it("offers a create only for a client the viewer is the officer of, or to an approver (`canPlan`), for every client", () => {
    const rows = [row({ engagementId: "e-a", clientName: "Ant" }), row({ engagementId: "e-b", clientName: "Bay", officer: { id: "u-me", name: "Me" } })];
    const by = (id: string, rs: AllocationRow[]) => Object.fromEntries(planClients(rs, null, "2026-10", id).map((c) => [c.engagementId, c.canCreate]));
    expect(by("u-me", rows)).toEqual({ "e-a": false, "e-b": true });
    expect(by("u-other", rows)).toEqual({ "e-a": false, "e-b": false });
    expect(by("u-other", rows.map((r) => ({ ...r, canPlan: true })))).toEqual({ "e-a": true, "e-b": true });
  });

  it("takes each client's cycle for the month on show from the cycle table", () => {
    const out = planClients([row({}), row({ engagementId: "e-b", clientName: "Bay" })], table([{ engagementId: "e-alpha", cycleId: "cy-nov" }, { engagementId: "e-b", cycleId: null }]), "2026-11", "u");
    expect(out.find((c) => c.engagementId === "e-alpha")?.cycleId).toBe("cy-nov");
    expect(out.find((c) => c.engagementId === "e-b")?.cycleId).toBeNull();
  });

  it("falls back to the allocation's own current cycle when the table could not be read, and to none for any other month", () => {
    expect(planClients([row({})], null, "2026-10", "u")[0].cycleId).toBe("cy-now");
    expect(planClients([row({})], null, "2026-11", "u")[0].cycleId).toBeNull();
  });

  it("dates the post that day at the client's default post time in the display zone, 09:00 with none or a malformed one", () => {
    expect(defaultPostIso("2026-10-20", "09:30")).toBe("2026-10-20T01:30:00.000Z");
    expect(defaultPostIso("2026-10-20", null)).toBe("2026-10-20T01:00:00.000Z");
    expect(defaultPostIso("2026-10-20", "9.30")).toBe("2026-10-20T01:00:00.000Z");
    expect(defaultPostIso("2026-10-20", "25:00")).toBe("2026-10-20T01:00:00.000Z");
  });
});
