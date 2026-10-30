// SCP-5d — `GET team`'s pure side (BFF §63.19), no database and no Cerbos: who holds what and for how long, the working-day averages, the
// report-due rule, the order, and the privacy narrowing. The database proof (the four and nobody else, the unit gate, equal team-level sections)
// is `team.http.test.ts`.
import { describe, it, expect } from "vitest";
import type { FeedCandidate } from "./feed-data";
import { holderRoleOf, isYourTurn } from "./feed";
import { SCP } from "./fixture";
import {
  ATTENTION_ORDER, WAIT_ROLES, boostAttention, clientRows, composeHoldings, estimatesNotSet, failedAttention, isVisible, monthRange, narrowPeople,
  postAttention, reportAttention, sortAttention, stepAverages, type PostCtx, type Roster,
} from "./team";
import type { CycleTable } from "./cycles-data";

const TODAY = "2026-10-28"; // a Wednesday
const CTX: PostCtx = { today: TODAY, tz: "UTC", calendar: {}, samples: new Map(), includeSimulated: false, simulatedIds: new Set() };

function cand(id: string, status: string, o: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    id, engagementId: "e1", clientId: "c1", clientName: "Mock Client", title: id, format: null, isExtra: false, pipelineStatus: status,
    statusSince: "2026-10-26T09:00:00.000Z", scheduledAt: null, authorId: null, ownerId: "officer-1", simulated: false, creativeSource: null,
    creativeState: null, creativeRequestId: null, scheduleVia: null, changeBy: null, changeKind: null, returnTo: null, changedOnly: false,
    blockedFrom: null, blockWaitingOn: null, cycleId: "cy1", readyBy: "2026-12-20", stepEstimates: {}, iAmAssignee: false, ...o,
  };
}
const design = (id: string, o: Partial<FeedCandidate> = {}) =>
  cand(id, "design", { creativeSource: "creatives", creativeState: "not_started", creativeRequestId: "req-1", ...o });

const ROSTER: Roster = {
  officers: ["officer-1", "officer-2"],
  copywriters: ["copy-1", "copy-2"],
  approvers: ["hod-1", "gm-1"],
  inTeamDesigners: ["inteam-1"],
  assigneesByRequest: new Map([["req-1", ["creatives-1"]]]),
  names: new Map([
    ["officer-1", "Mock Officer One"], ["officer-2", "Mock Officer Two"], ["copy-1", "Mock Copy One"], ["copy-2", "Mock Copy Two"],
    ["hod-1", "Mock HoD"], ["gm-1", "Mock GM"], ["inteam-1", "Mock In-team Designer"], ["creatives-1", "Mock Creatives Designer"],
  ]),
};

const waitOf = (waits: ReturnType<typeof composeHoldings>["waits"], role: string) => waits.find((w) => w.holderRole === role)!;
const rowOf = (workload: ReturnType<typeof composeHoldings>["workload"], role: string, id: string) => workload.find((w) => w.role === role && w.userId === id);

describe("waits are counted against the holder of each post (the fixture's holders), never the officer", () => {
  const posts = [
    cand("planned", "planned"), cand("drafting", "drafting"),                                                    // officer
    cand("proofread", "proofread"),                                                                               // copywriter
    cand("hod", "hod"), cand("final", "final"),                                                                   // approver
    design("design"),                                                                                              // designer
    cand("client", "client"),                                                                                      // client
    cand("approved", "approved"),                                                                                  // officer
    cand("blocked-ext", "blocked", { blockedFrom: "drafting", blockWaitingOn: "external" }),                      // external
    cand("blocked-client", "blocked", { blockedFrom: "hod", blockWaitingOn: "client" }),                          // client
    cand("fix-design", "changes", { changeBy: "final", changeKind: "design", returnTo: "final", creativeSource: "creatives", creativeRequestId: "req-1", creativeState: "in_progress" }), // designer
    cand("fix-copy", "changes", { changeBy: "hod", changeKind: "copy", returnTo: "hod" }),                         // officer
    cand("scheduled-manual", "scheduled", { scheduleVia: "manual" }),                                              // never waits
    cand("scheduled-pub", "scheduled", { scheduleVia: "publisher" }),                                              // never waits
    cand("live", "live"),                                                                                          // nobody
  ];

  it("every status lands on the role the fixture names, and a scheduled or live post waits on nobody", () => {
    const { waits } = composeHoldings(posts, CTX, ROSTER);
    expect(waits.map((w) => w.holderRole)).toEqual([...WAIT_ROLES]);
    expect(waitOf(waits, "officer").posts).toBe(4);     // planned, drafting, approved, the team copy change
    expect(waitOf(waits, "copywriter").posts).toBe(1);
    expect(waitOf(waits, "approver").posts).toBe(2);
    expect(waitOf(waits, "designer").posts).toBe(2);    // design, the final design change
    expect(waitOf(waits, "client").posts).toBe(2);      // with the client, and blocked on the client
    expect(waitOf(waits, "external").posts).toBe(1);
    // the roles are the feed's: nothing here is a second reading of the fixture
    for (const p of posts) {
      const role = holderRoleOf(p);
      if (["scheduled", "live"].includes(p.pipelineStatus)) continue;
      expect(WAIT_ROLES as readonly (string | null)[]).toContain(role);
    }
    expect(SCP.holders.proofread).toBe("copywriter");
  });

  it("a person's wait is their own: a post with the copywriter is not on the officer's row", () => {
    const { workload } = composeHoldings([cand("p1", "proofread"), cand("p2", "proofread")], CTX, ROSTER);
    expect(rowOf(workload, "officer", "officer-1")!.holding).toBe(0);
    expect(rowOf(workload, "copywriter", "copy-1")!.holding).toBe(2);
    expect(rowOf(workload, "copywriter", "copy-2")!.holding).toBe(2); // the shared queue: each copywriter could take both; the role counts each once
    expect(waitOf(composeHoldings([cand("p1", "proofread"), cand("p2", "proofread")], CTX, ROSTER).waits, "copywriter").posts).toBe(2);
  });

  it("a person's holding is `isYourTurn`, the feed's own rule: a maker never holds their own post to approve or proofread", () => {
    const own = cand("mine", "hod", { authorId: "hod-1" });                  // the HoD made it
    const copyOwn = cand("mine2", "proofread", { authorId: "copy-1" });
    const { workload } = composeHoldings([own, copyOwn, cand("other", "hod")], CTX, ROSTER);
    expect(rowOf(workload, "approver", "hod-1")!.holding).toBe(1); // only "other"
    expect(rowOf(workload, "approver", "gm-1")!.holding).toBe(2);
    expect(rowOf(workload, "copywriter", "copy-1")!.holding).toBe(0);
    expect(rowOf(workload, "copywriter", "copy-2")!.holding).toBe(1);
    // parity with the feed
    for (const [uid, role] of [["hod-1", "approver"], ["gm-1", "approver"], ["copy-1", "copywriter"], ["copy-2", "copywriter"]] as const) {
      const expected = [own, copyOwn, cand("other", "hod")].filter((p) => isYourTurn(p, holderRoleOf(p), {
        userId: uid, isCopywriter: role === "copywriter", isSeatApprover: role === "approver", isInTeamDesigner: false,
      })).length;
      expect(rowOf(workload, role, uid)!.holding).toBe(expected);
    }
  });

  it("an officer holds their own clients' posts only; a creatives designer holds the posts of the request they are assigned; an in-team designer the in-team posts", () => {
    const mine = cand("o1", "drafting", { ownerId: "officer-1" });
    const theirs = cand("o2", "drafting", { ownerId: "officer-2" });
    const inTeam = cand("d-in", "design", { creativeSource: "in_team", creativeState: "not_started" });
    const { workload } = composeHoldings([mine, theirs, design("d-cr"), inTeam], CTX, ROSTER);
    expect(rowOf(workload, "officer", "officer-1")!.holding).toBe(1);
    expect(rowOf(workload, "officer", "officer-2")!.holding).toBe(1);
    expect(rowOf(workload, "designer", "creatives-1")!.holding).toBe(1);
    expect(rowOf(workload, "designer", "inteam-1")!.holding).toBe(1);
  });

  it("the client and anyone outside the team have a total and no person rows", () => {
    const { waits } = composeHoldings(posts, CTX, ROSTER);
    expect(waitOf(waits, "client").people).toEqual([]);
    expect(waitOf(waits, "external").people).toEqual([]);
    expect(waitOf(waits, "copywriter").people.map((p) => p.userId).sort()).toEqual(["copy-1", "copy-2"]);
  });

  it("a person's row has an id, a name and counts, and nothing else (no sign-in, no e-mail)", () => {
    const { workload, waits } = composeHoldings(posts, CTX, ROSTER);
    for (const w of workload) expect(Object.keys(w).sort()).toEqual(["holding", "late", "name", "oldestSince", "role", "userId"]);
    for (const w of waits) for (const p of w.people) expect(Object.keys(p).sort()).toEqual(["name", "oldestSince", "posts", "userId"]);
    expect(JSON.stringify({ workload, waits })).not.toMatch(/"(?:e-?mail|last_?sign_?in|last_?login|last_?seen)[a-z_]*":/i);
  });

  it("counts a late post on the holder's row, and a person with nothing has a zero row", () => {
    const lateOne = cand("late-1", "proofread", { readyBy: "2026-10-10" });
    const { workload } = composeHoldings([lateOne, cand("fine", "proofread")], CTX, ROSTER);
    expect(rowOf(workload, "copywriter", "copy-1")).toMatchObject({ holding: 2, late: 1, oldestSince: "2026-10-26T09:00:00.000Z" });
    expect(rowOf(workload, "officer", "officer-2")).toMatchObject({ holding: 0, late: 0, oldestSince: null });
  });

  it("rows are ordered by role, then the heaviest load, then name", () => {
    const { workload } = composeHoldings([cand("p1", "proofread")], CTX, ROSTER);
    expect(workload.map((w) => w.role)).toEqual(["officer", "officer", "copywriter", "copywriter", "designer", "designer", "approver", "approver"]);
    const names = workload.filter((w) => w.role === "officer").map((w) => w.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("averageWorkingDays and oldestSince use the company's working days, with its holidays", () => {
  // status_since 2026-10-19 (Monday), today 2026-10-28 (Wednesday): working days in (19, 28] are 20, 21, 22, 23, 26, 27, 28 = 7 (24 and 25 are the weekend).
  const since = "2026-10-19T10:00:00.000Z";
  it("weekends are not counted", () => {
    const { waits } = composeHoldings([cand("a", "proofread", { statusSince: since })], CTX, ROSTER);
    expect(waitOf(waits, "copywriter")).toMatchObject({ posts: 1, oldestSince: since, averageWorkingDays: 7 });
  });
  it("a holiday is not counted", () => {
    const calendar = { holidays: [{ day: "2026-10-21", kind: "public" as const }] };
    const { waits } = composeHoldings([cand("a", "proofread", { statusSince: since })], { ...CTX, calendar }, ROSTER);
    expect(waitOf(waits, "copywriter").averageWorkingDays).toBe(6);
  });
  it("is the mean over the role's posts, rounded to two places; oldestSince is the earliest; a role with no post has null", () => {
    const posts = [
      cand("a", "proofread", { statusSince: since }),                           // 7
      cand("b", "proofread", { statusSince: "2026-10-27T08:00:00.000Z" }),      // 1
      cand("c", "proofread", { statusSince: "2026-10-28T08:00:00.000Z" }),      // 0
    ];
    const { waits } = composeHoldings(posts, CTX, ROSTER);
    expect(waitOf(waits, "copywriter")).toMatchObject({ posts: 3, oldestSince: since, averageWorkingDays: 2.67 });
    expect(waitOf(waits, "designer")).toMatchObject({ posts: 0, oldestSince: null, averageWorkingDays: null, people: [] });
  });
  it("counts the day in the company's time zone, not UTC", () => {
    // 2026-10-27T18:00Z is already the 28th in Jakarta (UTC+7), so it has waited 0 working days; in UTC it is the 27th, 1 day.
    const posts = [cand("a", "proofread", { statusSince: "2026-10-27T18:00:00.000Z" })];
    expect(waitOf(composeHoldings(posts, { ...CTX, tz: "Asia/Jakarta" }, ROSTER).waits, "copywriter").averageWorkingDays).toBe(0);
    expect(waitOf(composeHoldings(posts, CTX, ROSTER).waits, "copywriter").averageWorkingDays).toBe(1);
  });
});

describe("step averages", () => {
  it("average the working days each step took, in the fixture's status order, with their sample counts", () => {
    const avg = stepAverages([
      { step: "hod", enteredOn: "2026-10-20", leftOn: "2026-10-22" },        // 2
      { step: "hod", enteredOn: "2026-10-22", leftOn: "2026-10-27" },        // 23 24? 22 (Thu) -> 27 (Tue): 23, 26, 27 = 3
      { step: "proofread", enteredOn: "2026-10-26", leftOn: "2026-10-26" },  // 0
      { step: "client", enteredOn: "2026-10-23", leftOn: "2026-10-26" },     // Fri -> Mon: 1
    ], {});
    expect(avg).toEqual([
      { step: "proofread", averageWorkingDays: 0, samples: 1 },
      { step: "hod", averageWorkingDays: 2.5, samples: 2 },
      { step: "client", averageWorkingDays: 1, samples: 1 },
    ]);
    expect(avg.map((a) => a.step)).toEqual(SCP.statuses.filter((s) => avg.some((a) => a.step === s)));
  });
  it("skips holidays, and lists nothing for no moves", () => {
    const calendar = { holidays: [{ day: "2026-10-21", kind: "public" as const }] };
    expect(stepAverages([{ step: "hod", enteredOn: "2026-10-20", leftOn: "2026-10-22" }], calendar)).toEqual([{ step: "hod", averageWorkingDays: 1, samples: 1 }]);
    expect(stepAverages([], {})).toEqual([]);
  });
  it("monthRange is the month's first and last day, leap February included", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("report due: every engagement with a due day whose report of the month before is not delivered", () => {
  it("is due since the first of the requested month, titled by the month it covers, with the row's id only when there is one", () => {
    const items = reportAttention("2026-10", {
      due: [
        { engagementId: "e1", clientName: "Alpha", reportDueDay: 5, reportId: null },
        { engagementId: "e2", clientName: "Beta", reportDueDay: 31, reportId: "r2" },
      ],
      toCheck: [],
    }, "2026-10-31");
    expect(items).toEqual([
      { kind: "report_due", engagementId: "e1", clientName: "Alpha", title: "Monthly report 2026-09", since: "2026-10-01" },
      { kind: "report_due", reportId: "r2", engagementId: "e2", clientName: "Beta", title: "Monthly report 2026-09", since: "2026-10-01" },
    ]);
    expect("reportId" in items[0]).toBe(false); // omitted, not null
  });
  it("covers the year turn: January asks for December of the year before", () => {
    expect(reportAttention("2027-01", { due: [{ engagementId: "e", clientName: "A", reportDueDay: 1, reportId: null }], toCheck: [] }, "2027-01-15")[0])
      .toMatchObject({ title: "Monthly report 2026-12", since: "2027-01-01" });
  });
  it("a report in review is a report to check, with its own since", () => {
    const [r] = reportAttention("2026-10", { due: [], toCheck: [{ reportId: "r1", engagementId: "e1", clientName: "Alpha", kind: "monthly", period: "2026-09", since: "2026-10-12T08:00:00.000Z" }] }, "2026-10-01");
    expect(r).toEqual({ kind: "report_to_check", reportId: "r1", engagementId: "e1", clientName: "Alpha", title: "Monthly report 2026-09", since: "2026-10-12T08:00:00.000Z" });
  });
});

describe("report due is only due once the due day of the month has been reached (orchestrator ruling)", () => {
  const due = (day: number) => ({ due: [{ engagementId: "e", clientName: "A", reportDueDay: day, reportId: null }], toCheck: [] });
  it("not before the due day, due on it and after", () => {
    expect(reportAttention("2026-10", due(10), "2026-10-09")).toEqual([]);
    expect(reportAttention("2026-10", due(10), "2026-10-10")).toHaveLength(1);
    expect(reportAttention("2026-10", due(10), "2026-10-28")).toHaveLength(1);
  });
  it("a day past the month's end means its last day", () => {
    expect(reportAttention("2026-11", due(31), "2026-11-29")).toEqual([]);
    expect(reportAttention("2026-11", due(31), "2026-11-30")).toHaveLength(1);
    expect(reportAttention("2027-02", due(30), "2027-02-27")).toEqual([]);
    expect(reportAttention("2027-02", due(30), "2027-02-28")).toHaveLength(1);
  });
  it("a past month always qualifies, a future month never does", () => {
    expect(reportAttention("2026-09", due(31), "2026-10-02")).toHaveLength(1);
    expect(reportAttention("2026-11", due(1), "2026-10-31")).toEqual([]);
  });
  it("since stays the first of the month however late it is", () => {
    expect(reportAttention("2026-10", due(3), "2026-10-28")[0].since).toBe("2026-10-01");
  });
});

describe("needs attention: late, at risk, blocked, failed and boosts, optional fields omitted, in a fixed order", () => {
  it("late and at risk come from the feed's own health; a blocked and late post is both; holder only where a post has one", () => {
    const late = cand("late", "proofread", { readyBy: "2026-10-10" });
    const atRisk = cand("risk", "proofread", { readyBy: "2026-10-30", stepEstimates: { hod: 3, design: 3, final: 3, client: 3, schedule: 3 } });
    const fine = cand("fine", "proofread");
    const blockedLate = cand("bl", "blocked", { readyBy: "2026-10-10", blockedFrom: "drafting", blockWaitingOn: "external" });
    const items = postAttention([late, atRisk, fine, blockedLate], CTX);
    expect(items.map((i) => `${i.kind}:${i.postId}`)).toEqual(["late:late", "at_risk:risk", "late:bl", "blocked:bl"]);
    expect(items[0]).toEqual({
      kind: "late", postId: "late", engagementId: "e1", clientName: "Mock Client", title: "late", since: "2026-10-26T09:00:00.000Z",
      holder: { role: "copywriter", label: "A copywriter" },
    });
    expect(items[3].holder).toEqual({ role: "external", label: "Someone outside the team" });
    expect(items.every((i) => !("reportId" in i) && !("boostId" in i))).toBe(true);
  });
  it("a failed post and a boost waiting carry their ids and no holder", () => {
    const [f] = failedAttention([{ postId: "p", engagementId: "e", clientName: "A", title: "T", since: "2026-10-01T00:00:00.000Z" }]);
    expect(f).toEqual({ kind: "failed_post", postId: "p", engagementId: "e", clientName: "A", title: "T", since: "2026-10-01T00:00:00.000Z" });
    const [b] = boostAttention([{ boostId: "b", postId: "p", engagementId: "e", clientName: "A", title: "T", since: "2026-10-02T00:00:00.000Z" }]);
    expect(b).toEqual({ kind: "boost_waiting", postId: "p", boostId: "b", engagementId: "e", clientName: "A", title: "T", since: "2026-10-02T00:00:00.000Z" });
  });
  it("is ordered by kind (late first, reports last), then the longest in that state, then client, then id", () => {
    const mk = (kind: (typeof ATTENTION_ORDER)[number], since: string, clientName = "A", postId = "p"): ReturnType<typeof failedAttention>[number] =>
      ({ kind, postId, engagementId: "e", clientName, since });
    const shuffled = [
      mk("report_to_check", "2026-10-01"), mk("late", "2026-10-05", "B"), mk("boost_waiting", "2026-10-01"), mk("late", "2026-10-02", "Z"),
      mk("blocked", "2026-10-09"), mk("late", "2026-10-05", "A", "p2"), mk("at_risk", "2026-10-01"), mk("report_due", "2026-10-01"), mk("failed_post", "2026-10-01"),
      mk("late", "2026-10-05", "A", "p1"),
    ];
    const sorted = sortAttention(shuffled);
    expect(sorted.map((i) => i.kind)).toEqual(["late", "late", "late", "late", "at_risk", "blocked", "failed_post", "boost_waiting", "report_due", "report_to_check"]);
    expect(sorted.slice(0, 4).map((i) => `${i.since}/${i.clientName}/${i.postId}`)).toEqual([
      "2026-10-02/Z/p", "2026-10-05/A/p1", "2026-10-05/A/p2", "2026-10-05/B/p",
    ]);
    // a total order: the same set in another order sorts the same
    expect(sortAttention([...shuffled].reverse())).toEqual(sorted);
  });
  it("a late cycle step (SCP-5f) sits after the boosts and before the reports; two steps of one client on one day keep a total order", () => {
    const step = (step: string, since: string, engagementId = "e") => ({ kind: "cycle_step_late" as const, engagementId, clientName: "A", step, dueDate: since, since });
    const rows = [
      { kind: "report_due" as const, engagementId: "e", clientName: "A", since: "2026-10-01" },
      step("report", "2026-10-03"), { kind: "boost_waiting" as const, engagementId: "e", clientName: "A", postId: "p", since: "2026-10-09" },
      step("planning", "2026-10-03"), step("deploy", "2026-10-01", "e2"),
    ];
    const sorted = sortAttention(rows);
    expect(sorted.map((i) => i.kind)).toEqual(["boost_waiting", "cycle_step_late", "cycle_step_late", "cycle_step_late", "report_due"]);
    expect(sorted.filter((i) => i.kind === "cycle_step_late").map((i) => `${i.since}/${i.engagementId}/${i.step}`)).toEqual([
      "2026-10-01/e2/deploy", "2026-10-03/e/planning", "2026-10-03/e/report",
    ]);
    expect(sortAttention([...rows].reverse())).toEqual(sorted);
    expect(ATTENTION_ORDER.indexOf("cycle_step_late")).toBeGreaterThan(ATTENTION_ORDER.indexOf("boost_waiting"));
    expect(ATTENTION_ORDER.indexOf("cycle_step_late")).toBeLessThan(ATTENTION_ORDER.indexOf("report_due"));
  });
});

describe("simulated rows are counted as GET overview counts them", () => {
  it("off: left out by the post's own mark or a variant's (the ids), on: counted", () => {
    const own = cand("own", "proofread", { simulated: true });
    const viaVariant = cand("via", "proofread");
    const real = cand("real", "proofread");
    const ids = new Set(["via"]);
    expect([own, viaVariant, real].filter((c) => isVisible(c, false, ids)).map((c) => c.id)).toEqual(["real"]);
    expect([own, viaVariant, real].filter((c) => isVisible(c, true, ids)).map((c) => c.id)).toEqual(["own", "via", "real"]);
  });
  it("a simulated post is in no wait, no workload and no late item while the switch is off", () => {
    const sim = cand("s", "proofread", { simulated: true, readyBy: "2026-10-10" });
    const off = composeHoldings([sim], CTX, ROSTER);
    expect(waitOf(off.waits, "copywriter").posts).toBe(0);
    expect(postAttention([sim], CTX)).toEqual([]);
    const on = composeHoldings([sim], { ...CTX, includeSimulated: true }, ROSTER);
    expect(waitOf(on.waits, "copywriter").posts).toBe(1);
    expect(postAttention([sim], { ...CTX, includeSimulated: true }).map((i) => i.kind)).toEqual(["late"]);
  });
});

describe("the privacy narrowing of the per-person lists", () => {
  const held = composeHoldings([cand("p", "proofread"), cand("h", "hod"), design("d")], CTX, ROSTER);

  it("keeps the shown people, leaves the rest out of both lists, and says rows were limited only when the gate denied one", () => {
    const shown = new Set(["officer-1", "officer-2", "copy-1", "copy-2", "hod-1", "inteam-1"]);
    const n = narrowPeople(held, shown, new Set(["gm-1", "creatives-1"]));
    expect(n.limited).toBe(true);
    expect(n.workload.map((w) => w.userId)).not.toContain("gm-1");
    expect(n.workload.map((w) => w.userId)).not.toContain("creatives-1");
    expect(n.waits.flatMap((w) => w.people.map((p) => p.userId))).not.toContain("gm-1");
    expect(n.waits.flatMap((w) => w.people.map((p) => p.userId))).not.toContain("creatives-1");
    expect(n.workload.map((w) => w.userId)).toContain("hod-1");
  });
  it("a person left out because the gate could not answer is out, and does not read as `limited`", () => {
    const n = narrowPeople(held, new Set(held.workload.map((w) => w.userId).filter((id) => id !== "gm-1")), new Set());
    expect(n.workload.map((w) => w.userId)).not.toContain("gm-1");
    expect(n.limited).toBe(false);
  });
  it("shows everybody, limited false, when every person is shown", () => {
    const n = narrowPeople(held, new Set(held.workload.map((w) => w.userId)), new Set());
    expect(n).toEqual({ ...held, limited: false });
  });
  it("never touches the role totals: posts, oldest and average are the same whoever is shown", () => {
    const n = narrowPeople(held, new Set(), new Set(held.workload.map((w) => w.userId)));
    expect(n.limited).toBe(true);
    expect(n.workload).toEqual([]);
    expect(n.waits.map(({ people: _people, ...rest }) => rest)).toEqual(held.waits.map(({ people: _people, ...rest }) => rest));
    expect(n.waits.every((w) => w.people.length === 0)).toBe(true);
  });
});

describe("clients and estimates", () => {
  const counts = { counted: 6, planned: 1, inProduction: 1, withClient: 1, clientChanges: 0, approved: 1, scheduled: 1, live: 1, extra: 2, stories: 3 };
  const table = (rows: Array<Partial<CycleTable["rows"][number]>>): CycleTable => ({
    month: "2026-10", bufferWorkingDays: 1, holidaysKnown: true, canPlan: false,
    rows: rows.map((r, i) => ({
      engagementId: `e${i}`, clientName: `C${i}`, officer: null, deliveryBatch: null, cycleId: null, deadline: null, readyBy: null,
      prefill: { deadline: null, batch: null }, target: null, counts, health: null, ...r,
    })),
  });
  it("target against counted, approved (past the client's approval), live, extra and stories; no health without a cycle", () => {
    const [r] = clientRows(table([{ target: 8, officer: { id: "u", name: "Mock Officer" } }]));
    expect(r).toEqual({
      engagementId: "e0", clientName: "C0", officer: { id: "u", name: "Mock Officer" }, target: 8, counted: 6, approved: 3, live: 1, extra: 2, stories: 3, health: null,
    });
  });
  it("estimates not set: an engagement with none of the six", () => {
    const e = (id: string, stepEstimates: object) => ({ id, clientName: id, officerId: null, officerName: null, deliveryBatch: null, postsPerCycle: null, stepEstimates });
    expect(estimatesNotSet([e("a", {}), e("b", { hod: 2 }), e("c", {}), e("d", { client: 0 })])).toEqual([
      { engagementId: "a", clientName: "a" }, { engagementId: "c", clientName: "c" },
    ]);
  });
});
