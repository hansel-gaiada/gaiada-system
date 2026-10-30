import { describe, it, expect } from "vitest";
import {
  ATTENTION_LABEL, ATTENTION_ORDER, ATTENTION_WORDS, asTeamDashboard, attentionGroups, attentionHref, attentionMeta, clientHref, clientsByHealth, dashboardHref, holderText,
  lateOrAtRiskCount, partialText, postsText, settingsHref, sinceText, stepLabel, waitsSorted, workingDaysText, workloadSorted,
  type AttentionItem, type TeamClient, type WaitRow, type WorkloadRow,
} from "./socialTeam";

// SCP-5d (BFF §63.19): the Team dashboard's pure side: the parser (a wrong shape reads as "cannot tell"), where each attention row opens, the sorting and the words.

const health = (state: string) => ({ state, spareDays: 2, lateDays: null, lateWith: null, latestSafeHandoff: "2026-10-20", readyBy: "2026-10-25" });
const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: "late", postId: null, reportId: null, boostId: null, engagementId: "e-1", clientName: "Northwind Traders", title: null, since: "2026-10-05", holder: null, step: null, dueDate: null, ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  month: "2026-10", needsAttention: [], clients: [], workload: [], waits: [], stepAverages: [], estimatesNotSet: [], personRowsLimited: false, partial: [], ...over,
});

describe("asTeamDashboard: the parser", () => {
  it("reads the contract's shape", () => {
    const d = asTeamDashboard(body({
      needsAttention: [{ kind: "late", postId: "p-1", engagementId: "e-1", clientName: "Northwind Traders", title: "Harvest", since: "2026-10-05", holder: { role: "designer", label: "Kadek" } }],
      clients: [{ engagementId: "e-1", clientName: "Northwind Traders", officer: { id: "u-1", name: "Komang" }, target: 12, counted: 8, approved: 5, live: 3, extra: 1, stories: 2, health: health("on_track") }],
      workload: [{ userId: "u-1", name: "Komang", role: "officer", holding: 4, late: 1, oldestSince: "2026-10-01" }],
      waits: [{ holderRole: "client", posts: 2, oldestSince: "2026-10-02", averageWorkingDays: 1.5, people: [] }],
      stepAverages: [{ step: "hod", averageWorkingDays: 1.4, samples: 6 }],
      estimatesNotSet: [{ engagementId: "e-2", clientName: "Saltmarsh Day Spa" }],
    }));
    expect(d.month).toBe("2026-10");
    expect(d.needsAttention[0]).toMatchObject({ kind: "late", postId: "p-1", reportId: null, boostId: null, holder: { role: "designer", label: "Kadek" } });
    expect(d.clients[0]).toMatchObject({ target: 12, officer: { id: "u-1", name: "Komang" }, health: { state: "on_track" } });
    expect(d.workload[0]).toMatchObject({ role: "officer", holding: 4 });
    expect(d.waits[0]).toMatchObject({ holderRole: "client", averageWorkingDays: 1.5 });
    expect(d.stepAverages[0]).toEqual({ step: "hod", averageWorkingDays: 1.4, samples: 6 });
    expect(d.estimatesNotSet).toEqual([{ engagementId: "e-2", clientName: "Saltmarsh Day Spa" }]);
    expect(d.personRowsLimited).toBe(false);
    expect(d.partial).toEqual([]);
  });

  it("throws on a body that is not a dashboard: not an object, a bad month, a section that is not a list", () => {
    for (const bad of [null, undefined, "x", 3, [], {}, body({ month: "2026-13" }), body({ month: "October" }), body({ needsAttention: null }), body({ clients: {} }), body({ workload: "none" }),
      body({ waits: undefined }), body({ stepAverages: 0 }), body({ estimatesNotSet: null })]) {
      expect(() => asTeamDashboard(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("drops a row that is not a row, and keeps the others", () => {
    const d = asTeamDashboard(body({
      needsAttention: [
        null, "x", { kind: "nonsense", engagementId: "e", clientName: "C" }, { kind: "late", clientName: "C" }, { kind: "late", engagementId: "e" },
        { kind: "failed_post", postId: "p-9", engagementId: "e-1", clientName: "Northwind Traders", since: "2026-10-06" },
      ],
      clients: [{ engagementId: "e-1" }, { clientName: "No id" }, { engagementId: "e-2", clientName: "Saltmarsh Day Spa", target: "twelve", health: { state: "weird" } }],
      workload: [{ userId: "u-1", role: "janitor", holding: 1 }, { role: "officer" }, { userId: "u-2", name: "Wayan", role: "designer", holding: 2 }],
      waits: [{ holderRole: "nobody", posts: 1 }, { holderRole: "approver", posts: 3, people: [{ userId: "u-3", name: "Dewi", posts: 3 }, { name: "no id" }, 7] }],
      stepAverages: [{ step: 5 }, { step: "design", averageWorkingDays: "slow", samples: 2 }],
      estimatesNotSet: [{ engagementId: "e-3" }, { engagementId: "e-4", clientName: "Harborlight Hotel" }],
    }));
    expect(d.needsAttention.map((i) => i.kind)).toEqual(["failed_post"]);
    expect(d.clients.map((c) => c.engagementId)).toEqual(["e-2"]);
    // A target that is not a number reads as "not set", a health that is not a state as no health: never a made-up value.
    expect(d.clients[0]).toMatchObject({ target: null, health: null, counted: 0 });
    expect(d.workload.map((w) => w.userId)).toEqual(["u-2"]);
    expect(d.waits).toHaveLength(1);
    expect(d.waits[0].people.map((p) => p.userId)).toEqual(["u-3"]);
    expect(d.stepAverages).toEqual([{ step: "design", averageWorkingDays: null, samples: 2 }]);
    expect(d.estimatesNotSet).toEqual([{ engagementId: "e-4", clientName: "Harborlight Hotel" }]);
  });

  it("keeps `partial` and `personRowsLimited` as the server sent them, and reads a missing one as the quiet default", () => {
    const d = asTeamDashboard(body({ personRowsLimited: true, partial: ["workload", 7, "boosts", null] }));
    expect(d.personRowsLimited).toBe(true);
    expect(d.partial).toEqual(["workload", "boosts"]);
    const bare = asTeamDashboard({ month: "2026-10", needsAttention: [], clients: [], workload: [], waits: [], stepAverages: [], estimatesNotSet: [] });
    expect(bare.personRowsLimited).toBe(false);
    expect(bare.partial).toEqual([]);
    // Only the literal `true` limits: a truthy string does not.
    expect(asTeamDashboard(body({ personRowsLimited: "yes" })).personRowsLimited).toBe(false);
  });

  it("keeps the optional ids of a row, and no holder when the role is not a string", () => {
    const [r] = asTeamDashboard(body({
      needsAttention: [{ kind: "report_due", reportId: "r-1", engagementId: "e-1", clientName: "C", since: "2026-10-01", holder: { label: "x" } }],
    })).needsAttention;
    expect(r).toMatchObject({ kind: "report_due", reportId: "r-1", postId: null, boostId: null, holder: null });
  });
});

describe("attentionHref: where a row opens", () => {
  const D = "d-soc";
  it("sends a post row to its post page", () => {
    for (const kind of ["late", "at_risk", "blocked", "failed_post"] as const) {
      expect(attentionHref(D, item({ kind, postId: "p 1" }))).toBe("/departments/d-soc/posts/p%201");
    }
  });
  it("sends a report row to its report, and to the reports list when it has no id (an overdue report not yet drafted); never to the client profile", () => {
    for (const kind of ["report_due", "report_to_check"] as const) {
      expect(attentionHref(D, item({ kind, reportId: "rep-1" }))).toBe("/departments/d-soc/social-reports/rep-1");
      expect(attentionHref(D, item({ kind }))).toBe("/departments/d-soc/social-reports");
      // even a row that wrongly carries a post id is still a report
      expect(attentionHref(D, item({ kind, postId: "p-1", reportId: "rep-1" }))).not.toContain("/profile/");
      expect(attentionHref(D, item({ kind, postId: "p-1" }))).toBe("/departments/d-soc/social-reports");
    }
  });
  it("sends a boost row to the Boosting page, with or without a post id", () => {
    expect(attentionHref(D, item({ kind: "boost_waiting", boostId: "b-1" }))).toBe("/departments/d-soc/boosts");
    expect(attentionHref(D, item({ kind: "boost_waiting", boostId: "b-1", postId: "p-1" }))).toBe("/departments/d-soc/boosts");
  });
  it("falls back to the client's page only for a post row that names no post", () => {
    expect(attentionHref(D, item({ kind: "late", engagementId: "e/1" }))).toBe("/departments/d-soc/profile/e%2F1");
  });
  it("builds the other links, escaped", () => {
    expect(clientHref("d 1", "e-1")).toBe("/departments/d%201/profile/e-1");
    expect(settingsHref("d-soc")).toBe("/departments/d-soc/settings");
    expect(dashboardHref("d-soc", "2026-10", "2026-10-29")).toBe("/departments/d-soc/dashboard");
    expect(dashboardHref("d-soc", "2026-09", "2026-10-29")).toBe("/departments/d-soc/dashboard?month=2026-09");
  });
});

describe("the words", () => {
  it("has a label and a sentence for every kind", () => {
    expect(ATTENTION_ORDER).toHaveLength(8);
    for (const k of ATTENTION_ORDER) {
      expect(ATTENTION_LABEL[k], k).toBeTruthy();
      expect(ATTENTION_WORDS[k], k).toBeTruthy();
    }
  });
  it("says a waiting boost is requested and waiting for the client, or approved and not started (BFF §63.7)", () => {
    expect(ATTENTION_WORDS.boost_waiting).toMatch(/requested/i);
    expect(ATTENTION_WORDS.boost_waiting).toMatch(/waiting for the client/i);
    expect(ATTENTION_WORDS.boost_waiting).toMatch(/approved/i);
    expect(ATTENTION_WORDS.boost_waiting).toMatch(/not started/i);
    expect(ATTENTION_WORDS.boost_waiting).not.toMatch(/candidate/i);
  });
  it("says a due report is due on the client's report day and not yet sent", () => {
    expect(ATTENTION_WORDS.report_due).toMatch(/report day/i);
    expect(ATTENTION_WORDS.report_due).toMatch(/not yet sent/i);
  });
  it("names a part the server could not work out as unknown, not empty; an unknown name is shown as sent", () => {
    expect(partialText([])).toBeNull();
    expect(partialText(["workload", "boosts"])).toBe("Not worked out this time: workload, boosts. What is missing is unknown, not empty.");
    expect(partialText(["needsAttention", "mystery"])).toContain("needs attention, mystery");
  });
  it("words working days, dates and holders", () => {
    expect(workingDaysText(null)).toBe("No data yet");
    expect(workingDaysText(1)).toBe("1 working day");
    expect(workingDaysText(2.54)).toBe("2.5 working days");
    expect(workingDaysText(0)).toBe("0 working days");
    expect(sinceText("2026-10-05")).toBe("Since 5 Oct");
    expect(sinceText("2026-10-05T23:30:00Z")).toBe("Since 5 Oct");
    expect(sinceText(null)).toBe("No date");
    expect(sinceText("garbage")).toBe("No date");
    expect(holderText(null)).toBeNull();
    // The server's label is a role in words, never a person (BFF §63.19): shown as sent, first letter lowered to follow "With".
    expect(holderText({ role: "designer", label: "The designer" })).toBe("the designer");
    expect(holderText({ role: "approver", label: "The HoD or the GM" })).toBe("the HoD or the GM");
    expect(holderText({ role: "client", label: "" })).toBe("client");
    expect(stepLabel("hod")).toBe("HoD approval");
    expect(stepLabel("custom_step")).toBe("custom_step");
  });
  it("says a client's posts against its target, with the extras and stories beside", () => {
    expect(postsText({ target: 12, counted: 8, extra: 0, stories: 0 })).toEqual({ main: "8 of 12", beside: null });
    expect(postsText({ target: null, counted: 3, extra: 1, stories: 1 })).toEqual({ main: "3", beside: "1 extra · 1 story" });
    expect(postsText({ target: 4, counted: 4, extra: 2, stories: 3 })).toEqual({ main: "4 of 4", beside: "2 extra · 3 stories" });
  });
});

describe("sorting and grouping", () => {
  it("groups the attention rows in the contract's order, oldest first inside a kind, leaving out a kind with no row", () => {
    const groups = attentionGroups([
      item({ kind: "report_due", since: "2026-10-01" }), item({ kind: "late", postId: "b", since: "2026-10-09" }), item({ kind: "late", postId: "a", since: "2026-10-02" }),
      item({ kind: "boost_waiting", since: "2026-10-04" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["late", "boost_waiting", "report_due"]);
    expect(groups[0].items.map((i) => i.postId)).toEqual(["a", "b"]);
  });
  it("counts the late or at-risk rows only", () => {
    expect(lateOrAtRiskCount({ needsAttention: [item({ kind: "late" }), item({ kind: "at_risk" }), item({ kind: "blocked" }), item({ kind: "report_due" })] })).toBe(2);
    expect(lateOrAtRiskCount({ needsAttention: [] })).toBe(0);
  });
  it("lists clients worst health first, then by name, and a client with no cycle last", () => {
    const c = (clientName: string, state: string | null): TeamClient => ({
      engagementId: clientName, clientName, officer: null, target: null, counted: 0, approved: 0, live: 0, extra: 0, stories: 0,
      health: state ? ({ ...health(state) } as TeamClient["health"]) : null,
    });
    const sorted = clientsByHealth([c("Zed", "on_track"), c("Mid", null), c("Beta", "late"), c("Alpha", "late"), c("Yan", "at_risk"), c("Tee", "tight"), c("Done", "done")]);
    expect(sorted.map((x) => x.clientName)).toEqual(["Alpha", "Beta", "Yan", "Tee", "Zed", "Done", "Mid"]);
  });
  it("lists workload most held first, then most late, then by name", () => {
    const w = (name: string, holding: number, late: number): WorkloadRow => ({ userId: name, name, role: "officer", holding, late, oldestSince: null });
    expect(workloadSorted([w("B", 2, 0), w("A", 2, 1), w("C", 5, 0), w("D", 2, 0)]).map((x) => x.name)).toEqual(["C", "A", "B", "D"]);
  });
  it("lists the longest wait first, and a role with no date last", () => {
    const r = (holderRole: WaitRow["holderRole"], oldestSince: string | null, posts = 1): WaitRow => ({ holderRole, posts, oldestSince, averageWorkingDays: null, people: [] });
    expect(waitsSorted([r("client", null), r("designer", "2026-10-09"), r("officer", "2026-10-02"), r("approver", "2026-10-02", 4)]).map((x) => x.holderRole))
      .toEqual(["approver", "officer", "designer", "client"]);
  });
  it("does not change the lists it was given", () => {
    const rows = [item({ kind: "late", since: "2026-10-09" }), item({ kind: "late", since: "2026-10-01" })];
    attentionGroups(rows);
    expect(rows[0].since).toBe("2026-10-09");
  });
});

// SCP-5f (BFF §63.27.4): the needs-attention kind `cycle_step_late`: parsed with its step and day, worded, ordered before the reports and linked to the client's Plan tab.
describe("cycle_step_late", () => {
  const late = (over: Partial<AttentionItem> = {}): AttentionItem =>
    item({ kind: "cycle_step_late", engagementId: "e-9", title: "November 2026 plan", step: "planning", dueDate: "2026-10-12", since: "2026-10-12", ...over });

  it("is parsed with its step and its day, and carries no holder and no post", () => {
    const d = asTeamDashboard(body({ needsAttention: [{ kind: "cycle_step_late", engagementId: "e-9", clientName: "Northwind Traders", step: "planning", dueDate: "2026-10-12", title: "November 2026 plan", since: "2026-10-12" }] }));
    expect(d.needsAttention).toEqual([{
      kind: "cycle_step_late", postId: null, reportId: null, boostId: null, engagementId: "e-9", clientName: "Northwind Traders", title: "November 2026 plan",
      since: "2026-10-12", holder: null, step: "planning", dueDate: "2026-10-12",
    }]);
  });
  it("has a label and a sentence, sits after the boosts and before the reports, and is its own group", () => {
    expect(ATTENTION_LABEL.cycle_step_late).toBe("Cycle step late");
    expect(ATTENTION_WORDS.cycle_step_late).toMatch(/past its due date/);
    expect(ATTENTION_ORDER.indexOf("cycle_step_late")).toBeGreaterThan(ATTENTION_ORDER.indexOf("boost_waiting"));
    expect(ATTENTION_ORDER.indexOf("cycle_step_late")).toBeLessThan(ATTENTION_ORDER.indexOf("report_due"));
    const groups = attentionGroups([late({ since: "2026-10-12" }), late({ step: "report", since: "2026-10-03", dueDate: "2026-10-03" }), item({ kind: "late" })]);
    expect(groups.map((g) => g.kind)).toEqual(["late", "cycle_step_late"]);
    expect(groups[1].items.map((i) => i.step)).toEqual(["report", "planning"]); // the longest late first
  });
  it("opens the client's Plan tab, never a post or a report", () => {
    expect(attentionHref("d-soc", late())).toBe("/departments/d-soc/profile/e-9?tab=plan");
    expect(attentionHref("d-soc", late({ postId: "p-1", reportId: "r-1" }))).toBe("/departments/d-soc/profile/e-9?tab=plan");
  });
  it("says the day it was due in words, and the other kinds keep their own line", () => {
    expect(attentionMeta(late())).toBe("Was due 12 Oct");
    expect(attentionMeta(late({ dueDate: null, since: "2026-10-04" }))).toBe("Was due 4 Oct");
    expect(attentionMeta(item({ kind: "late", since: "2026-10-05", holder: { role: "designer", label: "The designer" } }))).toBe("Since 5 Oct · With the designer");
    expect(attentionMeta(item({ kind: "failed_post", since: "2026-10-05" }))).toBe("Since 5 Oct");
  });
  it("does not count as late or at risk in the Reports block", () => {
    expect(lateOrAtRiskCount({ needsAttention: [late(), item({ kind: "late" }), item({ kind: "at_risk" })] })).toBe(2);
  });
});
