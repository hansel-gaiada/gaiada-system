import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { addDaysIso } from "@/lib/checkins";
import type { ActivitySeries } from "@/lib/activitySeriesFormat";
import type { ReportOverview } from "@/lib/reports-data";
import { PlatformError } from "@/lib/platform";
import { agencyTree, lead, me as meFixture, member } from "@/lib/workspaceFixtures";

// DW-4i: Analytics > Team activity, for a head. The roster is the Team report's own reader; each person's series is read in
// parallel; rows are by name with counts BY KIND; no total, no ranking; a refused person says Unavailable on their row alone.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...r }: { href: string; children?: React.ReactNode }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/reports-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reports-data")>("@/lib/reports-data");
  return { ...actual, getReportOverview: vi.fn() };
});
vi.mock("@/lib/activitySeries", () => ({ getActivitySeries: vi.fn() }));

import { getMe } from "@/lib/platform";
import { readOrgRoot } from "@/lib/campaigns-data";
import { getReportOverview } from "@/lib/reports-data";
import { getActivitySeries } from "@/lib/activitySeries";
import TeamActivityPage from "./page";

const TO = "2026-10-15";
const KINDS = [
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
];
function answer(userId: string, over: Record<string, Record<string, number>> = {}): ActivitySeries {
  const days: ActivitySeries["days"] = [];
  for (let d = addDaysIso(TO, -100); d <= TO; d = addDaysIso(d, 1)) days.push({ date: d, counts: over[d] ?? {} });
  return { userId, from: days[0].date, to: TO, timezone: "UTC", kinds: KINDS, days, totals: {} };
}
const ROSTER: ReportOverview = {
  periodKind: "month", start: "2026-10-15", end: "2026-10-15", unit: "d-web",
  scopes: [
    { scopeRef: "u-3", scopeName: "Zed Busy", kpis: [], activity: true },
    { scopeRef: "u-2", scopeName: "Made Putra", kpis: [], activity: true },
    { scopeRef: "u-4", scopeName: "Ada Quiet", kpis: [], activity: false },
  ],
};
const BY_USER: Record<string, ActivitySeries> = {
  "u-3": answer("u-3", { "2026-10-14": { "github.commits": 50, "webdesk.edits": 7 }, "2026-09-20": { "github.commits": 9 } }),
  "u-2": answer("u-2", { "2026-10-14": { "github.commits": 2, "webdesk.edits": 1 }, "2026-10-09": { "github.commits": 4 } }),
  "u-4": answer("u-4"),
};

const head = meFixture([member(), lead("d-web")]);
const wide = meFixture([member(), { role: "reports_manager", scopeType: "company", scopeId: "co-a" }]);
const staff = meFixture([member()]);

const overviewMock = vi.mocked(getReportOverview);
const seriesMock = vi.mocked(getActivitySeries);

const mount = async (sp: { unit?: string; period?: string } = { unit: "d-web" }) =>
  render(await TeamActivityPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(head);
  vi.mocked(readOrgRoot).mockResolvedValue(agencyTree() as never);
  overviewMock.mockReset();
  overviewMock.mockResolvedValue(ROSTER);
  seriesMock.mockReset();
  seriesMock.mockImplementation(async (_u, _t, p) => ({ kind: "ok", data: BY_USER[p.subjectUserId] ?? answer(p.subjectUserId) }));
});

describe("Team activity: who sees it", () => {
  it("is not offered to staff who lead no one, and nothing about a team is read for them", async () => {
    vi.mocked(getMe).mockResolvedValue(staff);
    await mount();
    expect(screen.getByText(/Team activity is for the head of a department/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(overviewMock).not.toHaveBeenCalled();
    expect(seriesMock).not.toHaveBeenCalled();
  });

  it("is not offered to a head for a department they do not lead", async () => {
    await mount({ unit: "d-seo" });
    expect(screen.getByText(/Team activity is for the head of a department/)).toBeInTheDocument();
    expect(overviewMock).not.toHaveBeenCalled();
    expect(seriesMock).not.toHaveBeenCalled();
  });

  it("is offered to a head for a unit beneath the one they lead", async () => {
    await mount({ unit: "dv-fe" });
    expect(overviewMock).toHaveBeenCalledTimes(1);
  });

  it("is offered to a company-wide reader for any department", async () => {
    vi.mocked(getMe).mockResolvedValue(wide);
    await mount({ unit: "d-seo" });
    expect(overviewMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

describe("Team activity: the unit picker", () => {
  it("offers a head the units they lead, and what sits beneath them", async () => {
    await mount({});
    const picker = screen.getByRole("heading", { level: 3, name: "Choose a department" }).closest("section")!;
    expect(within(picker).getAllByRole("link").map((a) => a.textContent)).toEqual(["Frontend", "Web Dev"]);
    expect(within(picker).getByRole("link", { name: "Web Dev" })).toHaveAttribute("href", "/analytics/activity/team?unit=d-web&period=month");
    expect(overviewMock).not.toHaveBeenCalled();
  });

  it("offers a company-wide reader every department", async () => {
    vi.mocked(getMe).mockResolvedValue(wide);
    await mount({});
    const picker = screen.getByRole("heading", { level: 3, name: "Choose a department" }).closest("section")!;
    expect(within(picker).getAllByRole("link").map((a) => a.textContent)).toEqual(["Frontend", "GM", "SEO", "Web Dev"]);
  });

  it("says the organisation could not be read, rather than offering nothing as if there were no unit", async () => {
    vi.mocked(readOrgRoot).mockResolvedValue(null);
    await mount({});
    expect(screen.getByText(/Unavailable: the organisation could not be read/)).toBeInTheDocument();
  });
});

describe("Team activity: the table", () => {
  it("reads the unit's roster as of today, then every person's series in parallel from 100 days back, with no `to`", async () => {
    await mount();
    expect(overviewMock).toHaveBeenCalledTimes(1);
    expect(overviewMock.mock.calls[0][2]).toMatchObject({ grain: "person", unit: "d-web" });
    expect(seriesMock).toHaveBeenCalledTimes(3);
    for (const call of seriesMock.mock.calls) {
      expect(call[2].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(call[2]).not.toHaveProperty("to");
    }
    expect(seriesMock.mock.calls.map((c) => c[2].subjectUserId).sort()).toEqual(["u-2", "u-3", "u-4"]);
  });

  it("is a real table with a caption that says it is not a ranking and not a score", async () => {
    await mount();
    const table = screen.getByRole("table");
    expect(within(table).getByText(/Work done by kind, 01 Oct 2026 to 15 Oct 2026\. People are listed by name\. The counts are not a ranking and not a score/)).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Person", "Done in this period, by kind", "Their activity"]);
  });

  it("lists rows by NAME, never by volume (the busiest person is not first)", async () => {
    await mount();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual(["Ada Quiet", "Made Putra", "Zed Busy"]);
  });

  it("shows each person's counts BY KIND for this month by default, cut from the server's own today", async () => {
    await mount();
    const row = (name: string) => within(screen.getByRole("table")).getByRole("rowheader", { name }).closest("tr")!;
    expect(within(row("Zed Busy")).getByText("Commits 50, Site edits 7")).toBeInTheDocument(); // the 20 Sep commits are last month
    expect(within(row("Made Putra")).getByText("Commits 6, Site edits 1")).toBeInTheDocument();
    expect(within(row("Ada Quiet")).getByText("Nothing recorded in this period")).toBeInTheDocument();
  });

  it("cuts a week and a quarter from the same answer, and marks the chosen period", async () => {
    await mount({ unit: "d-web", period: "week" });
    expect(screen.getByRole("link", { name: "This week" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "This month" })).not.toHaveAttribute("aria-current");
    const made = within(screen.getByRole("table")).getByRole("rowheader", { name: "Made Putra" }).closest("tr")!;
    expect(within(made).getByText("Commits 2, Site edits 1")).toBeInTheDocument(); // 9 Oct is before this week's Monday (12 Oct)
    expect(screen.getByText(/Work done by kind, 12 Oct 2026 to 15 Oct 2026/)).toBeInTheDocument();
  });

  it("has no total column, no sort control and no ranking anywhere", async () => {
    await mount();
    const table = screen.getByRole("table");
    expect(within(table).queryAllByRole("button")).toHaveLength(0);
    // The caption says what this is NOT; the headers and the rows say nothing of a total, a rank or a score.
    const cells = [...within(table).getAllByRole("columnheader"), ...within(table).getAllByRole("cell"), ...within(table).getAllByRole("rowheader")];
    expect(cells.map((c) => c.textContent).join(" | ")).not.toMatch(/total|rank|score|rating/i);
    for (const th of within(table).getAllByRole("columnheader")) expect(th).not.toHaveAttribute("aria-sort");
  });

  it("links each row to that person's own My activity view, keeping the unit", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "Open Made Putra's activity" })).toHaveAttribute("href", "/analytics/activity?user=u-2&unit=d-web");
  });

  it("says Unavailable on the row of a refused or failed person only, never zeros", async () => {
    seriesMock.mockImplementation(async (_u, _t, p) => {
      if (p.subjectUserId === "u-3") return { kind: "forbidden" };
      if (p.subjectUserId === "u-4") return { kind: "error", reason: "boom" };
      return { kind: "ok", data: BY_USER["u-2"] };
    });
    await mount();
    const row = (name: string) => within(screen.getByRole("table")).getByRole("rowheader", { name }).closest("tr")!;
    expect(within(row("Zed Busy")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(row("Ada Quiet")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(row("Made Putra")).getByText("Commits 6, Site edits 1")).toBeInTheDocument();
    expect(within(row("Made Putra")).queryByText("Unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing recorded in this period")).not.toBeInTheDocument();
  });
});

describe("Team activity: the roster read", () => {
  it("says No access on a refusal and Unavailable on a failure, and reads no person's series", async () => {
    overviewMock.mockRejectedValue(new PlatformError(403, "outside your reporting line"));
    const { unmount } = await mount();
    expect(screen.getByText(/No access: Team activity is for the head of a department/)).toBeInTheDocument();
    unmount();
    overviewMock.mockRejectedValue(new PlatformError(500, "boom"));
    await mount();
    expect(screen.getByText(/Unavailable: the roster could not be read \(boom\)/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(seriesMock).not.toHaveBeenCalled();
  });

  it("says nobody is placed in the department for an empty roster, never an empty table", async () => {
    overviewMock.mockResolvedValue({ ...ROSTER, scopes: [] });
    await mount();
    expect(screen.getByText("Nobody is placed in this department.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
