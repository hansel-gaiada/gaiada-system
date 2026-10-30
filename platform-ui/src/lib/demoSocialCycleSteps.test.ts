import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";

// SCP-5f (BFF §63.27.4): the DEMO_MODE answer of the cycle health's `steps` and the Team dashboard's `cycle_step_late`. The stores seed from the day they are first touched, so
// the clock is pinned to Friday 16 October 2026 before they are imported (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { allocStore, cyclesStore, PIPE_POSTS, demoWalkBack } from "./demoSocialPipeline";
import { demoCycleSteps, resetDemoStepMarks, type DemoStepInput, type DemoStepPost } from "./demoSocialCycleSteps";
import { demoLateSteps } from "./demoSocialCycleStepsRead";
import { runDemoPipelineAction } from "./demoSocialPipelineRun";
import { asCycleView } from "./socialClient";
import { asTeamDashboard } from "./socialTeam";

const base = "/api/co-agency/modules/social";
const health = (cycleId: string) => socialDemo("GET", `${base}/cycles/${cycleId}/health`, new URLSearchParams());
const stepsOf = (cycleId: string) => asCycleView(health(cycleId)?.json).steps ?? [];
const KEYS = ["report", "planning", "copy_lock", "artwork", "client_window", "deploy"];
const NORTH_NOW = "soc-cyc-soc-eng-1-2026-10";

const post = (id: string, status: string, o: Partial<DemoStepPost> = {}): DemoStepPost => ({
  id, pipelineStatus: status, isExtra: false, format: "feed", changeCase: null, changedOnly: false, blockedFrom: null, archivedAt: null, ...o,
});
const input = (posts: DemoStepPost[], o: Partial<DemoStepInput> = {}): DemoStepInput => ({
  cycleId: "cy-x", month: "2026-12", readyBy: "2026-11-27", today: "2026-11-01", target: 2,
  estimates: { proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 }, reportDueDay: 5, posts, reportDelivered: false, walkBack: demoWalkBack, ...o,
});
const byKey = (rows: ReturnType<typeof demoCycleSteps>) => Object.fromEntries(rows.map((r) => [r.step, r]));

beforeEach(() => resetDemoStepMarks());

describe("GET cycles/:cycleId/health answers the six steps of every demo cycle", () => {
  it("in the rules' order, each with a task id, a due date and a state in the server's shape; the parser reads them", () => {
    for (const c of cyclesStore.cycles) {
      const r = health(c.id);
      expect(r?.status, c.id).toBe(200);
      expect((r?.json as { stepsReason: unknown }).stepsReason).toBeNull();
      const steps = stepsOf(c.id);
      expect(steps.map((s) => s.step), c.id).toEqual(KEYS);
      for (const s of steps) {
        expect(s.taskId).toBeTruthy();
        expect(s.autoClose).toBe("auto");
        expect(s.done ? s.holder === null && s.progress === 100 : s.holder === "The officer").toBe(true);
        expect(s.done && s.late).toBe(false);
      }
    }
  });

  it("shows every state across the demo: done, open with progress, late, and an open step not yet due", () => {
    const all = cyclesStore.cycles.flatMap((c) => stepsOf(c.id));
    expect(all.some((s) => s.done)).toBe(true);
    expect(all.some((s) => !s.done && !s.late && s.progress > 0)).toBe(true);
    expect(all.some((s) => !s.done && !s.late && s.progress === 0)).toBe(true);
    expect(all.some((s) => s.late)).toBe(true);
  });

  it("the report step closes on the delivery of the monthly report two months before the cycle's (the demo has one delivered)", () => {
    expect(stepsOf(NORTH_NOW).find((s) => s.step === "report")).toMatchObject({ done: true, progress: 100 });
    const hotel = cyclesStore.cycles.find((c) => c.engagementId === "soc-eng-4" && c.month === "2026-10")!;
    expect(stepsOf(hotel.id).find((s) => s.step === "report")).toMatchObject({ done: false, late: true });
  });
});

describe("the step conditions are the server's (BFF §63.27.2)", () => {
  it("planning closes when the target is met and nothing is planned or drafting; the other steps need every counted post past their point", () => {
    const two = (a: string, b: string) => byKey(demoCycleSteps(input([post("1", a), post("2", b)])));
    expect(two("planned", "proofread").planning).toMatchObject({ done: false, progress: 50 });
    expect(two("proofread", "hod").planning).toMatchObject({ done: true, progress: 100 });
    expect(two("design", "final").copy_lock.done).toBe(true);
    expect(two("hod", "final").copy_lock).toMatchObject({ done: false, progress: 50 });
    expect(two("final", "client").artwork.done).toBe(true);
    expect(two("approved", "scheduled").client_window.done).toBe(true);
    expect(two("approved", "live").deploy.done).toBe(false);
    expect(two("scheduled", "live").deploy.done).toBe(true);
    // a target not met keeps planning, client approval and scheduling open, but not the copy lock or the artwork
    const one = byKey(demoCycleSteps(input([post("1", "live")])));
    expect(one.planning.done).toBe(false);
    expect(one.deploy.done).toBe(false);
    expect(one.copy_lock.done).toBe(true);
    // extra posts and stories are beside the target
    const extra = byKey(demoCycleSteps(input([post("1", "live"), post("2", "live"), post("3", "planned", { isExtra: true }), post("4", "planned", { format: "story" })])));
    expect(extra.deploy.done).toBe(true);
  });

  it("a design change keeps the copy lock and reopens artwork; a blocked post counts from where it was blocked", () => {
    const changes = byKey(demoCycleSteps(input([post("1", "changes", { changeCase: "final_design" }), post("2", "final")], { target: 2 })));
    expect(changes.copy_lock.done).toBe(true);
    expect(changes.artwork.done).toBe(false);
    const blocked = byKey(demoCycleSteps(input([post("1", "blocked", { blockedFrom: "client" }), post("2", "client")])));
    expect(blocked.artwork.done).toBe(true);
    expect(blocked.client_window.done).toBe(false);
  });

  it("the due dates walk back from ready-by by the estimates; with none every step but the report is due on ready-by; the report is on the client's day in the month before", () => {
    const d = byKey(demoCycleSteps(input([])));
    // ready-by Fri 27 Nov 2026; deploy R; client approval less 1; artwork less 4; copy lock less 7; planning less 9
    expect([d.deploy, d.client_window, d.artwork, d.copy_lock, d.planning].map((s) => s.dueDate)).toEqual(["2026-11-27", "2026-11-26", "2026-11-23", "2026-11-18", "2026-11-16"]);
    expect(d.report.dueDate).toBe("2026-11-05");
    const none = byKey(demoCycleSteps(input([], { estimates: {}, reportDueDay: null })));
    expect(none.planning.dueDate).toBe("2026-11-27");
    expect(none.report.dueDate).toBeNull();
    expect(none.report.late).toBe(false);
    // a report day past the month's end means its last day
    expect(byKey(demoCycleSteps(input([], { reportDueDay: 31, month: "2026-03" }))).report.dueDate).toBe("2026-02-28");
  });

  it("an open step is late once past its date, and a done one never is", () => {
    const rows = byKey(demoCycleSteps(input([post("1", "client")], { today: "2026-11-20" })));
    expect(rows.report.late).toBe(true); // due 5 Nov, not delivered
    expect(rows.planning).toMatchObject({ done: false, late: true }); // due 16 Nov: one post of a target of two, so open and past due
    expect(rows.copy_lock).toMatchObject({ done: true, late: false }); // due 18 Nov, but done
    expect(rows.client_window.late).toBe(false); // due 26 Nov
  });
});

describe("one step is closed by hand, then reopened at the next recompute (BFF §63.27.3)", () => {
  it("stays done while the posts are as they were, and reopens when a stage action changes one", () => {
    const first = stepsOf(NORTH_NOW).find((s) => s.step === "client_window")!;
    expect(first).toMatchObject({ done: true, progress: 100, late: false });
    expect(stepsOf(NORTH_NOW).find((s) => s.step === "client_window")!.done).toBe(true); // a second read changes nothing
    // The officer records a client approval on a post that was with the client: a stage action on a counted post, so the next recompute.
    const target = PIPE_POSTS.find((p) => p.cycleId === NORTH_NOW && p.pipelineStatus === "client" && !p.isExtra && p.format !== "story");
    expect(target, "a counted post with the client in the first client's cycle").toBeTruthy();
    const r = runDemoPipelineAction(target!.id, { action: "record_client_approve", expectedStatus: "client", channel: "whatsapp", note: "Approved on a call." }, "u-social");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(stepsOf(NORTH_NOW).find((s) => s.step === "client_window")).toMatchObject({ done: false, holder: "The officer" });
    expect(stepsOf(NORTH_NOW).find((s) => s.step === "client_window")!.progress).toBeLessThan(100);
  });

  it("it is closed only by hand: its own condition does not hold, and no other demo cycle is seeded that way", () => {
    const a = allocStore.byEngagement["soc-eng-1"];
    const natural = byKey(demoCycleSteps(input(PIPE_POSTS.filter((p) => p.cycleId === NORTH_NOW), {
      cycleId: "natural", readyBy: cyclesStore.cycles.find((c) => c.id === NORTH_NOW)!.readyBy, month: "2026-10", target: a.postsPerCycle, estimates: a.stepEstimates,
    })));
    expect(natural.client_window.done).toBe(false);
    expect(stepsOf(NORTH_NOW).find((s) => s.step === "client_window")!.done).toBe(true);
    // every other step of that cycle, and every step of the other cycles, is what the posts say
    for (const c of cyclesStore.cycles.filter((x) => x.id !== NORTH_NOW)) {
      const al = allocStore.byEngagement[c.engagementId];
      const own = byKey(demoCycleSteps(input(PIPE_POSTS.filter((p) => p.cycleId === c.id), { cycleId: `own-${c.id}`, readyBy: c.readyBy, month: c.month, target: al.postsPerCycle, estimates: al.stepEstimates })));
      expect(stepsOf(c.id).find((s) => s.step === "client_window")!.done, c.id).toBe(own.client_window.done);
    }
  });
});

describe("GET team lists cycle_step_late", () => {
  const team = (month: string) => asTeamDashboard(socialDemo("GET", `${base}/team`, new URLSearchParams({ month }))?.json);

  it("one row per late open step of the month's cycles, team-level: a client, a step, a day; no holder, no post, no person", () => {
    const late = team("2026-10").needsAttention.filter((i) => i.kind === "cycle_step_late");
    expect(late.length).toBeGreaterThan(0);
    expect(late.length).toBe(demoLateSteps("2026-10").length);
    for (const i of late) {
      expect(i.step).toBeTruthy();
      expect(i.dueDate && i.dueDate < "2026-10-16").toBe(true);
      expect(i.since).toBe(i.dueDate);
      expect(i.holder).toBeNull();
      expect(i.postId).toBeNull();
      expect(i.title).toBeTruthy();
    }
    // the same steps the health read calls late
    const fromHealth = cyclesStore.cycles.filter((c) => c.month === "2026-10").flatMap((c) => stepsOf(c.id).filter((s) => s.late).map((s) => `${c.engagementId}/${s.step}`));
    expect(late.map((i) => `${i.engagementId}/${i.step}`).sort()).toEqual(fromHealth.sort());
  });

  it("a month with no cycle lists none", () => {
    expect(team("2027-06").needsAttention.filter((i) => i.kind === "cycle_step_late")).toEqual([]);
  });
});
