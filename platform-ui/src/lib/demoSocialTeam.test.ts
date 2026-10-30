import { describe, it, expect, vi, afterAll, afterEach } from "vitest";

// SCP-5d (BFF §63.19): DEMO_MODE's answer for `GET team?month=`. The stores seed from the day they are first touched, so the clock is pinned to Friday 16 October 2026
// before they are imported (as demoSocialOverview.test.ts does); a test that needs another day moves it with `vi.setSystemTime`. Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { demoTeamRoute } from "./demoSocialTeam";
import { demoBoosts, type BoostRec } from "./demoSocialBoosts";
import { PIPE_POSTS, CREATIVES_DESIGNER } from "./demoSocialPipeline";
import { asTeamDashboard, type TeamDashboard } from "./socialTeam";
import { socialDemo } from "./demoSocial";
import { demoReportsFor } from "./demoSocialReports";

const FOUR = ["u-pm", "u-gm", "demo-owner", "demo-hansel"] as const;
const NOT_APPROVERS = ["u-social", "u-social-2", "u-copy", "u-creative", "u-social-design", "u-dev", "demo-client", "demo-client-viewer", "someone-else"];
const NOON_16TH = "2026-10-16T04:00:00Z";
afterEach(() => vi.setSystemTime(new Date(NOON_16TH)));

const read = (user: string, month = "2026-10") => demoTeamRoute(new URLSearchParams({ month }), user);
const dashboard = (user: string, month = "2026-10"): TeamDashboard => {
  const r = read(user, month);
  expect(r.status, `${user} ${month}`).toBe(200);
  return asTeamDashboard(r.json);
};
const waitingBoosts = (): BoostRec[] => demoBoosts.store.boosts.filter((b) => b.status === "requested" || (b.status === "approved" && b.startedAt === null));

describe("who reads it: the four approvers, nobody else", () => {
  it("answers each of the four with a dashboard the UI's own parser accepts", () => {
    for (const u of FOUR) {
      const d = dashboard(u);
      expect(d.month).toBe("2026-10");
      expect(d.clients.length).toBeGreaterThan(0);
    }
  });

  it("refuses everyone else with 403 not_a_social_approver, officers, the copywriter, the designers and a client contact included", () => {
    for (const u of NOT_APPROVERS) {
      const r = read(u);
      expect(r.status, u).toBe(403);
      expect(r.json, u).toEqual({ error: "not_a_social_approver" });
    }
  });

  it("checks who BEFORE the month: a non-approver with a bad month still gets 403, not 400", () => {
    for (const u of NOT_APPROVERS) expect(read(u, "garbage").status, u).toBe(403);
    expect(demoTeamRoute(new URLSearchParams(), "u-social").status).toBe(403);
  });

  it("answers an approver with a bad month 400 invalid_field, naming the field", () => {
    for (const month of ["2026-13", "2026-00", "2026-1", "26-10", "October", "2026-10-01", "2026/10"]) {
      const r = read("u-pm", month);
      expect(r.status, month).toBe(400);
      expect(r.json, month).toEqual({ error: "invalid_field", field: "month" });
    }
  });

  it("reads this month when no month is given", () => {
    const r = demoTeamRoute(new URLSearchParams(), "u-pm");
    expect(r.status).toBe(200);
    expect((r.json as { month: string }).month).toBe("2026-10");
  });

  it("is routed from the module's demo as GET team, and only GET", () => {
    const ok = socialDemo("GET", "/api/co-agency/modules/social/team", new URLSearchParams("month=2026-10"), undefined, "u-pm");
    expect(ok?.status).toBe(200);
    expect(socialDemo("GET", "/api/co-agency/modules/social/team", new URLSearchParams("month=2026-10"), undefined, "u-social")?.status).toBe(403);
    expect(socialDemo("POST", "/api/co-agency/modules/social/team", new URLSearchParams(), "{}", "u-pm")?.status).not.toBe(200);
  });
});

describe("per-person rows (BFF §63.19)", () => {
  it("the owner and the superadmin see every person's row, the Creatives designer's included, and personRowsLimited is false", () => {
    for (const u of ["demo-owner", "demo-hansel"]) {
      const d = dashboard(u);
      expect(d.personRowsLimited, u).toBe(false);
      expect(d.workload.some((w) => w.userId === CREATIVES_DESIGNER && w.role === "designer"), u).toBe(true);
      expect(d.waits.find((w) => w.holderRole === "designer")!.people.map((p) => p.userId), u).toContain(CREATIVES_DESIGNER);
    }
  });

  it("the HoD and the GM do not see a person outside the Social Media unit, and personRowsLimited says so", () => {
    for (const u of ["u-pm", "u-gm"]) {
      const d = dashboard(u);
      expect(d.personRowsLimited, u).toBe(true);
      expect(d.workload.map((w) => w.userId), u).not.toContain(CREATIVES_DESIGNER);
      for (const w of d.waits) expect(w.people.map((p) => p.userId), `${u} ${w.holderRole}`).not.toContain(CREATIVES_DESIGNER);
    }
  });

  it("the HoD and the GM still see every person of the unit", () => {
    const owner = dashboard("demo-owner");
    const unit = owner.workload.filter((w) => w.userId !== CREATIVES_DESIGNER).map((w) => w.userId).sort();
    expect(unit.length).toBeGreaterThan(0);
    for (const u of ["u-pm", "u-gm"]) expect(dashboard(u).workload.map((w) => w.userId).sort(), u).toEqual(unit);
  });

  it("the team-level sections are the same for every reader and the role totals are not narrowed", () => {
    const [first, ...rest] = FOUR.map((u) => dashboard(u));
    const teamLevel = (d: TeamDashboard) => ({
      needsAttention: d.needsAttention, clients: d.clients, stepAverages: d.stepAverages, estimatesNotSet: d.estimatesNotSet,
      waits: d.waits.map(({ holderRole, posts, oldestSince, averageWorkingDays }) => ({ holderRole, posts, oldestSince, averageWorkingDays })),
    });
    for (const d of rest) expect(teamLevel(d)).toEqual(teamLevel(first));
    // The designer's wait is counted for the HoD although the designer's own row is left out.
    expect(dashboard("u-pm").waits.find((w) => w.holderRole === "designer")!.posts).toBeGreaterThan(0);
  });

  it("the demo lists no sign-in anywhere (it is IT's data, BFF §63.19)", () => {
    const text = JSON.stringify(read("demo-owner").json).toLowerCase();
    expect(text).not.toMatch(/sign-?in|signin|last_?seen|lastlogin|last_login/);
  });
});

describe("boosts come from the boosts store, never invented from reach", () => {
  it("lists exactly the requested boosts and the approved ones not yet started, the Overview's Boosts waiting rule", () => {
    const rows = dashboard("u-pm").needsAttention.filter((i) => i.kind === "boost_waiting");
    const expected = waitingBoosts().filter((b) => b.startsOn.startsWith("2026-10"));
    expect(expected.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.boostId).sort()).toEqual(expected.map((b) => b.id).sort());
    // The seed holds one approved-and-not-started and two requested boosts; the running and the completed one are not waiting.
    expect(demoBoosts.store.boosts.some((b) => b.status === "running")).toBe(true);
    expect(demoBoosts.store.boosts.some((b) => b.status === "completed")).toBe(true);
    for (const b of demoBoosts.store.boosts.filter((x) => x.status === "running" || x.status === "completed")) expect(rows.map((r) => r.boostId)).not.toContain(b.id);
  });

  it("names the client and the post, and carries the boost id, not a made-up one", () => {
    const rows = dashboard("u-pm").needsAttention.filter((i) => i.kind === "boost_waiting");
    for (const r of rows) {
      const b = demoBoosts.store.boosts.find((x) => x.id === r.boostId)!;
      expect(b, r.boostId ?? "").toBeTruthy();
      expect(r.title).toBe(PIPE_POSTS.find((p) => p.id === b.postId)!.title);
      expect(r.engagementId).toBe(b.engagementId);
      expect(r.clientName).toBeTruthy();
      expect(r.boostId).not.toMatch(/^boost-demo-/);
    }
  });

  it("follows the store: a started boost drops out, a new request appears, an archived post's boost is left out", () => {
    const store = demoBoosts.store.boosts;
    const approved = store.find((b) => b.status === "approved" && b.startedAt === null)!;
    const idsNow = () => dashboard("u-pm").needsAttention.filter((i) => i.kind === "boost_waiting").map((i) => i.boostId);
    expect(idsNow()).toContain(approved.id);
    const saved = { ...approved };
    try {
      approved.startedAt = "2026-10-15T09:00:00.000Z";
      expect(idsNow()).not.toContain(approved.id);
      approved.startedAt = saved.startedAt;
      approved.status = "declined";
      expect(idsNow()).not.toContain(approved.id);
      approved.status = "requested";
      expect(idsNow()).toContain(approved.id);
      const post = PIPE_POSTS.find((p) => p.id === approved.postId)!;
      const archivedAt = post.archivedAt;
      post.archivedAt = "2026-10-15T00:00:00.000Z";
      try { expect(idsNow()).not.toContain(approved.id); } finally { post.archivedAt = archivedAt; }
    } finally {
      Object.assign(approved, saved);
    }
    expect(idsNow()).toContain(approved.id);
  });

  it("a boost belongs to the month its start falls in", () => {
    expect(dashboard("u-pm", "2026-09").needsAttention.filter((i) => i.kind === "boost_waiting")).toEqual([]);
    expect(dashboard("u-pm", "2026-11").needsAttention.filter((i) => i.kind === "boost_waiting")).toEqual([]);
  });

  it("a live post with a large reach is no boost row by itself", () => {
    const strong = PIPE_POSTS.filter((p) => p.pipelineStatus === "live" && p.metrics && p.metrics.reach >= 2000 && p.cycleMonth === "2026-10");
    const boostPosts = new Set(demoBoosts.store.boosts.map((b) => b.postId));
    const rows = dashboard("u-pm").needsAttention.filter((i) => i.kind === "boost_waiting");
    for (const p of strong.filter((x) => !boostPosts.has(x.id))) expect(rows.map((r) => r.title)).not.toContain(p.title);
  });
});

describe("report rows (from the monthly report demo, on the server's rules: BFF §63.18, §63.19)", () => {
  const reports = (d: TeamDashboard) => d.needsAttention.filter((i) => i.kind === "report_due" || i.kind === "report_to_check");
  const dueClients = (month?: string) => reports(dashboard("u-pm", month)).filter((i) => i.kind === "report_due").map((i) => i.clientName).sort();

  it("a report due is last month's: since the first of this month, titled for its period, the report's id when one exists and none when it does not", () => {
    const sep = demoReportsFor("2026-09");
    const due = reports(dashboard("u-pm")).filter((i) => i.kind === "report_due");
    expect(due.length).toBe(3);
    for (const r of due) {
      expect(r.since).toBe("2026-10-01");
      expect(r.title).toBe("Monthly report 2026-09");
      expect(r.postId).toBeNull();
      const row = sep.find((x) => x.engagementId === r.engagementId);
      expect(r.reportId, r.clientName).toBe(row ? row.id : null);
    }
    // Saltmarsh has no report for September yet: due, with no id, so the row opens the list to draft it.
    expect(due.find((r) => r.clientName === "Saltmarsh Day Spa")!.reportId).toBeNull();
  });

  it("a report to check is every report in the HoD check, today, whatever month is shown", () => {
    for (const month of ["2026-09", "2026-10", "2026-11"]) {
      const check = reports(dashboard("u-pm", month)).filter((i) => i.kind === "report_to_check");
      expect(check.map((r) => r.clientName), month).toEqual(["Harborlight Hotel"]);
      for (const r of check) expect(r.reportId).toMatch(/\S/);
    }
  });

  it("is due only once the client's report day of the month is reached (Northwind the 5th, Harborlight the 7th, Saltmarsh the 10th), and a Sent report is never due", () => {
    vi.setSystemTime(new Date("2026-10-04T04:00:00Z"));
    expect(dueClients()).toEqual([]);
    vi.setSystemTime(new Date("2026-10-09T04:00:00Z"));
    expect(dueClients()).toEqual(["Harborlight Hotel", "Northwind Traders"]);
    vi.setSystemTime(new Date("2026-10-10T04:00:00Z"));
    expect(dueClients()).toEqual(["Harborlight Hotel", "Northwind Traders", "Saltmarsh Day Spa"]);
    // September's view looks at August: Northwind's August report was Sent, so only the other two are due.
    expect(dueClients("2026-09")).toEqual(["Harborlight Hotel", "Saltmarsh Day Spa"]);
  });

  it("a later month has no report due yet", () => {
    expect(dueClients("2026-11")).toEqual([]);
  });
});

describe("the other sections and the partial option", () => {
  it("puts the cycles table's clients in, with health, and every kind of row in a known kind", () => {
    const d = dashboard("u-pm");
    expect(d.clients.map((c) => c.clientName).sort()).toEqual(["Harborlight Hotel", "Northwind Traders", "Saltmarsh Day Spa"]);
    const kinds = new Set(["late", "at_risk", "blocked", "failed_post", "boost_waiting", "cycle_step_late", "report_due", "report_to_check"]);
    for (const i of d.needsAttention) expect(kinds.has(i.kind), i.kind).toBe(true);
  });

  it("a month with no posts has no step averages and no waits, rather than invented ones", () => {
    const d = dashboard("u-pm", "2026-01");
    expect(d.stepAverages).toEqual([]);
    expect(d.waits).toEqual([]);
    expect(d.workload).toEqual([]);
  });
});

describe("SCP-5d demo: needs attention names roles, never people (BFF §63.19: team-level, the same for every reader)", () => {
  it("labels each holder with the server's role words, and only late, at-risk and blocked rows carry a holder", () => {
    const words = new Set(["The officer", "A copywriter", "The HoD or the GM", "The designer", "The client", "Someone outside the team"]);
    for (const u of ["u-pm", "u-gm", "demo-owner", "demo-hansel"]) {
      for (const it of dashboard(u).needsAttention as Array<{ kind: string; holder?: { label: string } }>) {
        if (it.holder) {
          expect(["late", "at_risk", "blocked"], `${u} ${it.kind}`).toContain(it.kind);
          expect(words.has(it.holder.label), `${u} ${it.kind} ${it.holder.label}`).toBe(true);
        }
      }
    }
  });
});
