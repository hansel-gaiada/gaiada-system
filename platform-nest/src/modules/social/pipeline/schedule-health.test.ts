// SCP-1c — the schedule-health maths, PURE (no database, no Cerbos): the golden table replayed, then the fixture pins and the
// invariants no table row can show. The table (`schedule-health-golden.json`) was computed by hand; nothing here recomputes it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, countWorkingDays, type WorkingCalendar } from "../../hr/working-days";
import {
  APPROVAL_WINDOW_DAYS, COUNT_OF_PHASE, changedOnlySkippedSteps, HEALTH_SEVERITY, STEP_KEYS, addWorkingDays, averageApprovalDays, clientHealth,
  firstWorkingDayOnOrAfter, fixtureSlice, isClientSlower, isMonthKey, lastDayOfMonth, lastWorkingDayOnOrBefore, parseStepEstimates,
  postHealth, postHolder, postPhase, prefillDeadline, previousMonth, readyByFor, remainingSteps, remainingWorkingDays,
  spareDaysBetween, tallyCounts, workingDaysBetween,
  type CountedPost, type DeliveryBatch, type Health, type HealthPost, type StepEstimates,
} from "./schedule-health";

interface GoldenCalendar { weekendDays?: number[]; holidays?: string[] }
const golden = JSON.parse(readFileSync(join(__dirname, "schedule-health-golden.json"), "utf8")) as {
  prefill: Array<{ name: string; month: string; batch: DeliveryBatch | null; calendar: GoldenCalendar | null; expect: string | null }>;
  readyBy: Array<{ name: string; deadline: string; buffer: number; calendar: GoldenCalendar | null; expect: string }>;
  remaining: Array<{ name: string; post: HealthPost; steps: string[] | null }>;
  holder: Array<{ post: HealthPost; expect: string | null }>;
  health: Array<{
    name: string; today: string; readyBy: string; calendar: GoldenCalendar | null; estimates: "E9" | StepEstimates;
    clientSlower: boolean; post: HealthPost;
    expect: { state: string; spareDays: number | null; lateDays: number | null; lateWith: string | null; latestSafeHandoff: string | null };
  }>;
  client: Array<{ name: string; readyBy: string; posts: Health[]; expect: Health | null }>;
  approval: Array<{ name: string; calendar: GoldenCalendar | null; samples: Array<{ requestedOn: string; decidedOn: string }>; average: number | null }>;
  slower: Array<{ name: string; average: number | null; estimate: number | null; expect: boolean }>;
  counts: Array<{ name: string; posts: Array<Partial<CountedPost> & { status: string }>; expect: Record<string, number> }>;
};

const E9: StepEstimates = { proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 };
const cal = (c: GoldenCalendar | null): WorkingCalendar =>
  c === null ? {} : { ...(c.weekendDays ? { weekendDays: c.weekendDays } : {}), holidays: (c.holidays ?? []).map((day) => ({ day, kind: "public" as const })) };
const asPost = (p: Partial<CountedPost> & { status: string }): CountedPost => ({ isExtra: false, format: null, ...p });

describe("the golden table is well formed", () => {
  it("covers every case the ticket names", () => {
    const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name).join(" ");
    expect(golden.prefill.length).toBeGreaterThanOrEqual(20);
    expect(golden.readyBy.length).toBeGreaterThanOrEqual(15);
    expect(golden.health.length).toBeGreaterThanOrEqual(60);
    // month ends, weekends, a holiday on the deadline and one inside the window, the year turn, a buffer of 0, no calendar, a custom weekend
    expect(names(golden.prefill)).toMatch(/month_end/);
    expect(names(golden.prefill)).toMatch(/year_turn/);
    expect(names(golden.prefill)).toMatch(/custom_weekend/);
    expect(names(golden.prefill)).toMatch(/known_calendar_without_holidays/);
    expect(names(golden.readyBy)).toMatch(/buffer_0/);
    expect(names(golden.readyBy)).toMatch(/holiday_on_the_deadline/);
    expect(names(golden.readyBy)).toMatch(/holiday_inside_the_window/);
    expect(names(golden.readyBy)).toMatch(/year_turn/);
    expect(golden.prefill.some((r) => r.calendar === null)).toBe(true);
    expect(golden.health.some((r) => r.calendar?.weekendDays)).toBe(true);
    // every state, each in the table
    for (const s of ["on_track", "tight", "at_risk", "late", "done"]) expect(golden.health.some((r) => r.expect.state === s), s).toBe(true);
    // posts in changes and blocked, with and without estimates
    for (const status of ["changes", "blocked"]) {
      expect(golden.health.some((r) => r.post.status === status && r.estimates === "E9"), `${status} with`).toBe(true);
      expect(golden.health.some((r) => r.post.status === status && typeof r.estimates === "object" && Object.keys(r.estimates).length === 0), `${status} without`).toBe(true);
    }
    // names are unique within a section
    for (const rows of [golden.prefill, golden.readyBy, golden.health, golden.client, golden.approval, golden.slower, golden.counts, golden.remaining]) {
      expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
    }
  });
});

describe("the A/B pre-fill (golden)", () => {
  for (const c of golden.prefill) {
    it(c.name, () => expect(prefillDeadline(c.month, c.batch, cal(c.calendar))).toBe(c.expect));
  }
});

describe("ready-by (golden)", () => {
  for (const c of golden.readyBy) {
    it(c.name, () => expect(readyByFor(c.deadline, c.buffer, cal(c.calendar))).toBe(c.expect));
  }
});

describe("which steps remain (golden)", () => {
  for (const c of golden.remaining) {
    it(c.name, () => expect(remainingSteps(c.post)).toEqual(c.steps));
  }
});

describe("who holds the post (golden, from the fixture)", () => {
  for (const c of golden.holder) {
    it(`${c.post.status} ${c.post.changeBy ?? c.post.blockedFrom ?? ""} ${c.post.changeKind ?? ""}`.trim(), () => expect(postHolder(c.post)).toBe(c.expect));
  }
});

describe("post health (golden)", () => {
  for (const c of golden.health) {
    it(c.name, () => {
      const h = postHealth({
        today: c.today, readyBy: c.readyBy, calendar: cal(c.calendar), estimates: c.estimates === "E9" ? E9 : c.estimates,
        clientSlower: c.clientSlower, post: c.post,
      });
      expect(h).toEqual({ ...c.expect, readyBy: c.readyBy });
    });
  }
});

describe("the client's health: the worst post (golden)", () => {
  for (const c of golden.client) {
    it(c.name, () => expect(clientHealth(c.posts, c.readyBy)).toEqual(c.expect));
  }
});

describe("the client's average approval time and 'slower than usual' (golden)", () => {
  for (const c of golden.approval) {
    it(c.name, () => expect(averageApprovalDays(c.samples, cal(c.calendar))).toBe(c.average));
  }
  for (const c of golden.slower) {
    it(c.name, () => expect(isClientSlower(c.average, c.estimate ?? undefined)).toBe(c.expect));
  }
  it("the look-back is 90 days", () => expect(APPROVAL_WINDOW_DAYS).toBe(90));
});

describe("the counts (golden)", () => {
  for (const c of golden.counts) {
    it(c.name, () => expect(tallyCounts(c.posts.map(asPost))).toEqual(c.expect));
  }
});

describe("pinned to the stage-machine fixture (never retyped)", () => {
  const fx = fixtureSlice();
  const index = (k: string) => (STEP_KEYS as readonly string[]).indexOf(k);

  it("the six estimate steps are the steps of the fixture's pipeline, in order", () => {
    // `proofread`, `hod`, `design`, `final` and `client` are statuses of the fixture; `schedule` is the step that ends in `scheduled`.
    for (const k of ["proofread", "hod", "design", "final", "client"]) expect(fx.statuses, k).toContain(k);
    expect(STEP_KEYS.map((k) => index(k))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("every change case counts from its return step inclusive and has a holder", () => {
    expect(fx.changeCases).toHaveLength(6);
    for (const cc of fx.changeCases) {
      const post: HealthPost = { status: "changes", changeBy: cc.changeBy, changeKind: cc.changeKind, returnTo: cc.returnTo };
      expect(remainingSteps(post), cc.key).toEqual(STEP_KEYS.slice(index(cc.returnTo)));
      expect(postHolder(post), cc.key).toBe(cc.holder);
      expect(postPhase(post), cc.key).toBe(cc.phase);
    }
  });

  it("every status has a phase, and a holder (or none for live) the way the fixture says", () => {
    for (const s of fx.statuses) {
      if (s === "changes") continue;
      expect(postPhase({ status: s }), s).toBe(fx.phaseOf[s]);
    }
    for (const s of ["planned", "drafting", "proofread", "hod", "design", "final", "client", "approved"]) {
      expect(postHolder({ status: s }), s).toBe(String(fx.holders[s]).split(" ")[0]);
    }
    expect(postHolder({ status: "live" })).toBeNull();
  });

  it("loop e: the steps it skips are derived from approve_copy's `to` rule, and the rule is pinned here so a fixture edit forces a review", () => {
    const approveCopy = fx.actions.find((a) => a.action === "approve_copy");
    expect(approveCopy?.to).toEqual([{ when: { changedOnly: false }, status: "hod" }, { when: { changedOnly: true }, status: "client" }]);
    expect(changedOnlySkippedSteps()).toEqual(["hod", "design", "final"]);
    // the case it applies to is the fixture's client_copy (return to proofread), and it is set by return_copy while changedOnly
    const clientCopy = fx.changeCases.find((c) => c.key === "client_copy")!;
    expect(clientCopy.returnTo).toBe("proofread");
    const withLoopE = remainingSteps({ status: "changes", changeBy: clientCopy.changeBy, changeKind: clientCopy.changeKind, returnTo: clientCopy.returnTo, changedOnly: true });
    expect(withLoopE).toEqual(["proofread", "client", "schedule"]);
    // without changed_only (which the database does not produce for this case) the answer is the cautious full path, never the short one
    expect(remainingSteps({ status: "changes", changeBy: clientCopy.changeBy, changeKind: clientCopy.changeKind, returnTo: clientCopy.returnTo })).toEqual([...STEP_KEYS]);
    expect(remainingSteps({ status: "changes", changeBy: clientCopy.changeBy, changeKind: clientCopy.changeKind, returnTo: clientCopy.returnTo, changedOnly: false })).toEqual([...STEP_KEYS]);
    // every other change case ignores changed_only
    for (const cc of fx.changeCases.filter((c) => c.key !== "client_copy")) {
      const post: HealthPost = { status: "changes", changeBy: cc.changeBy, changeKind: cc.changeKind, returnTo: cc.returnTo };
      expect(remainingSteps({ ...post, changedOnly: true }), cc.key).toEqual(remainingSteps(post));
    }
  });

  it("every blockable status counts as itself when blocked, and every status is either counted or done", () => {
    for (const b of fx.blockableStatuses) {
      if (b === "changes") continue;
      expect(remainingSteps({ status: "blocked", blockedFrom: b, blockWaitingOn: "client" }), b).toEqual(remainingSteps({ status: b }));
    }
    for (const s of fx.statuses) {
      if (s === "changes" || s === "blocked") continue;
      const r = remainingSteps({ status: s });
      if (["approved", "scheduled", "live"].includes(s)) expect(r, s).toBeNull();
      else expect(r, s).not.toBeNull();
    }
  });

  it("the count keys stand for exactly the fixture's phases", () => {
    const phases = fx.phases.map((p) => p.key).sort();
    expect([...Object.keys(COUNT_OF_PHASE), "client_approved"].sort()).toEqual(phases);
    // every fixture status or change case lands on a count key, so a posts' phase counts always sum to `counted`
    const everyStatus: CountedPost[] = fx.statuses.filter((s) => s !== "changes").map((s) => asPost({ status: s }));
    const everyCase: CountedPost[] = fx.changeCases.map((c) => asPost({ status: "changes", changeBy: c.changeBy, changeKind: c.changeKind, returnTo: c.returnTo }));
    const t = tallyCounts([...everyStatus, ...everyCase]);
    expect(t.planned + t.inProduction + t.withClient + t.clientChanges + t.approved + t.scheduled + t.live).toBe(t.counted);
    expect(t.counted).toBe(everyStatus.length + everyCase.length);
  });
});

describe("working-day primitives agree with hr/working-days (no second calendar)", () => {
  it("snapping and stepping", () => {
    expect(firstWorkingDayOnOrAfter("2026-03-07", {})).toBe("2026-03-09");
    expect(lastWorkingDayOnOrBefore("2026-03-08", {})).toBe("2026-03-06");
    expect(addWorkingDays("2026-03-09", -1, {})).toBe("2026-03-06");
    expect(addWorkingDays("2026-03-06", 1, {})).toBe("2026-03-09");
    expect(addWorkingDays("2026-03-07", 0, {})).toBe("2026-03-07");
    expect(workingDaysBetween("2026-03-06", "2026-03-09", {})).toBe(1);
    expect(workingDaysBetween("2026-03-09", "2026-03-06", {})).toBe(0);
  });
  it("a calendar with every day off terminates (it never loops)", () => {
    const allOff: WorkingCalendar = { weekendDays: [1, 2, 3, 4, 5, 6, 7] };
    expect(firstWorkingDayOnOrAfter("2026-03-07", allOff)).toBe("2026-03-07");
    expect(lastWorkingDayOnOrBefore("2026-03-07", allOff)).toBe("2026-03-07");
    expect(spareDaysBetween("2026-03-07", "2026-03-09", allOff)).toBeGreaterThanOrEqual(0);
  });
  it("months", () => {
    expect(previousMonth("2026-01")).toBe("2025-12");
    expect(previousMonth("2026-03")).toBe("2026-02");
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2026-12")).toBe("2026-12-31");
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-1")).toBe(false);
    expect(isMonthKey("2026-12")).toBe(true);
  });
  it("estimates parse to integers 0 to 30 only", () => {
    expect(parseStepEstimates({ proofread: 1, hod: 31, design: -1, final: 1.5, client: "2", schedule: 30, extra: 4 })).toEqual({ proofread: 1, schedule: 30 });
    expect(parseStepEstimates(null)).toEqual({});
    expect(parseStepEstimates([1])).toEqual({});
    expect(remainingWorkingDays(STEP_KEYS, E9)).toBe(9);
    expect(remainingWorkingDays(STEP_KEYS, {})).toBe(0);
  });
});

describe("invariants a table row cannot show", () => {
  const calendars: Array<[string, WorkingCalendar]> = [
    ["no calendar", {}],
    ["christmas holidays", cal({ holidays: ["2025-12-25", "2025-12-26", "2026-01-01"] })],
    ["friday and saturday weekend", cal({ weekendDays: [5, 6] })],
  ];

  it("a pre-fill is a working day on or before its anchor, in every month of three years", () => {
    for (const [label, c] of calendars) {
      for (let y = 2025; y <= 2027; y++) {
        for (let m = 1; m <= 12; m++) {
          const month = `${y}-${String(m).padStart(2, "0")}`;
          const prev = previousMonth(month);
          for (const batch of ["A", "B"] as const) {
            const d = prefillDeadline(month, batch, c)!;
            const anchor = batch === "A" ? `${prev}-15` : lastDayOfMonth(prev);
            expect(d <= anchor, `${label} ${month} ${batch}`).toBe(true);
            expect(d.slice(0, 7) === prev, `${label} ${month} ${batch} stays in the month before`).toBe(true);
            expect(firstWorkingDayOnOrAfter(d, c), `${label} ${month} ${batch} is a working day`).toBe(d);
            // the last one: nothing between it and the anchor works
            expect(workingDaysBetween(d, anchor, c), `${label} ${month} ${batch} is the LAST working day`).toBe(0);
          }
        }
      }
    }
  });

  it("ready-by is on or before the deadline and exactly `buffer` working days earlier", () => {
    for (const [label, c] of calendars) {
      for (let i = 0; i < 120; i++) {
        const deadline = addDays("2025-11-20", i);
        for (const buffer of [0, 1, 2, 5, 10]) {
          const r = readyByFor(deadline, buffer, c);
          expect(r <= deadline, `${label} ${deadline}/${buffer}`).toBe(true);
          // the deadline day itself is never counted: `buffer` working days sit in [ready-by, the day before the deadline]
          if (buffer === 0) expect(r, `${label} ${deadline}/0`).toBe(deadline);
          else {
            expect(countWorkingDays(r, addDays(deadline, -1), c).workingDays, `${label} ${deadline}/${buffer}`).toBe(buffer);
            expect(firstWorkingDayOnOrAfter(r, c), `${label} ${deadline}/${buffer} lands on a working day`).toBe(r);
          }
        }
      }
    }
  });

  it("a fixed post never gets healthier as today moves on: on_track, tight, at_risk, late", () => {
    const posts: HealthPost[] = [
      { status: "planned" }, { status: "design" }, { status: "client" },
      { status: "changes", changeBy: "client", changeKind: "design", returnTo: "final" },
      { status: "blocked", blockedFrom: "hod", blockWaitingOn: "approver" },
    ];
    for (const [label, c] of calendars) {
      for (const post of posts) {
        for (const estimates of [E9, {} as StepEstimates, { design: 3, client: 2 } as StepEstimates]) {
          for (const clientSlower of [false, true]) {
            let worst = -1;
            for (let i = 0; i < 70; i++) {
              const today = addDays("2025-12-01", i);
              const h = postHealth({ today, readyBy: "2026-01-09", calendar: c, estimates, clientSlower, post });
              const rank = HEALTH_SEVERITY[h.state];
              expect(rank, `${label} ${post.status} ${today}`).toBeGreaterThanOrEqual(worst);
              worst = rank;
              // the figures agree with the state
              if (h.state === "late") { expect(today > "2026-01-09").toBe(true); expect(h.lateDays).not.toBeNull(); expect(h.lateWith).not.toBeNull(); }
              else { expect(h.lateDays).toBeNull(); expect(h.lateWith).toBeNull(); }
              if (h.state === "on_track") expect(h.spareDays!).toBeGreaterThanOrEqual(1);
              if (h.state === "tight") expect(h.spareDays!).toBeGreaterThanOrEqual(0);
              if (h.state === "at_risk") { expect(h.spareDays!).toBeLessThan(0); expect(today <= "2026-01-09").toBe(true); }
            }
          }
        }
      }
    }
  });

  it("spare days fall by exactly one per working day that passes", () => {
    const c = cal({ holidays: ["2026-03-11"] });
    let previous: number | null = null;
    for (let i = 0; i < 20; i++) {
      const today = addDays("2026-03-02", i);
      if (firstWorkingDayOnOrAfter(today, c) !== today) continue; // only working days advance the count
      const s = spareDaysBetween(today, "2026-03-20", c);
      if (previous !== null) expect(s).toBe(previous - 1);
      previous = s;
    }
  });
});
