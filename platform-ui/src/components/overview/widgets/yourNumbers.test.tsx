import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { YourNumbers } from "./YourNumbers";
import { WidgetBoundary } from "../WidgetBoundary";
import { OVERVIEW_PERIODS, selectBands } from "@/lib/overview";
import { WORKSPACES, isPlanned } from "@/lib/workspaces";
import * as reports from "@/lib/reports-data";
import type { ReportDocument, ReportKpi } from "@/lib/reports";
import { me as meFixture, member } from "@/lib/workspaceFixtures";

vi.mock("@/lib/reports-data", () => ({ getReportDocument: vi.fn() }));

const person = meFixture([member()]);
const getReport = vi.mocked(reports.getReportDocument);

const kpi = (metricKey: string, value: number, extra: Partial<ReportKpi> = {}): ReportKpi => ({
  metricKey, label: metricKey, unit: "count", value, appraisalSafe: true, direction: "up_good", ...extra,
});
const FULL: ReportKpi[] = [
  kpi("delivery.tasks_completed", 12, { delta: 3 }),
  kpi("delivery.on_time_rate", 0.8, { unit: "percent", numerator: 8, denominator: 10, delta: -0.04 }),
  kpi("effort.minutes_logged", 750, { unit: "minutes", delta: -90, appraisalSafe: false }),
  kpi("discipline.checkin_compliance", 0.9, { unit: "percent", numerator: 9, denominator: 10, delta: 0.1 }),
];
const doc = (kpis: ReportKpi[], warnings?: ReportDocument["header"]["warnings"]): ReportDocument => ({
  header: {
    tenantId: "co-a", grain: "person", scopeRef: "u-1", scopeName: "Made", periodKind: "month",
    periodStart: "2026-10-01", periodEnd: "2026-10-31", dayCount: 31, periodLabel: "October 2026",
    generatedAt: "2026-10-13T08:00:00Z", sealed: false,
    comparison: { periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30 },
    ...(warnings ? { warnings } : {}),
  },
  kpis, series: [], distributions: [], tables: [], highlights: [], narrative: { source: "deterministic", text: "" },
});
const props = (extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key: "your-numbers", band: "you", label: "Your numbers" }, ...extra,
});
const tiles = () => within(screen.getByRole("region", { name: "Your numbers" })).getAllByRole("listitem");
const values = () => tiles().map((li) => li.querySelector(".ov-nums__value")?.textContent);

beforeEach(() => {
  getReport.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Your numbers (the widget)", () => {
  it("reads the signed-in person's report for the Overview's company, once, for every period", async () => {
    for (const period of OVERVIEW_PERIODS) {
      getReport.mockReset();
      getReport.mockResolvedValue(doc(FULL));
      await YourNumbers(props({ period }));
      expect(getReport).toHaveBeenCalledTimes(1);
      expect(getReport).toHaveBeenCalledWith("co-a", "u-1", {
        grain: "person", scopeRef: "u-1", periodKind: period, start: "2026-10-13", end: "2026-10-13",
      });
    }
  });

  it("draws the four tiles with their values, details and changes, and names the compared range once", async () => {
    getReport.mockResolvedValue(doc(FULL));
    render(await YourNumbers(props()));
    const t = tiles();
    expect(t).toHaveLength(4);
    expect(t.map((li) => li.querySelector(".ov-nums__label")?.textContent)).toEqual(["Tasks done", "On time", "Hours logged", "Check-ins"]);
    expect(values()).toEqual(["12", "80%", "12.5 h", "9 of 10"]);
    expect(within(t[1]).getByText("8 of 10")).toBeInTheDocument();
    expect(within(t[3]).getByText("90%")).toBeInTheDocument();
    // Changes, in each tile's own unit.
    expect(within(t[0]).getByText("3")).toBeInTheDocument();
    expect(within(t[1]).getByText("4pp")).toBeInTheDocument();
    expect(within(t[2]).getByText("1.5 h")).toBeInTheDocument();
    expect(within(t[3]).getByText("10pp")).toBeInTheDocument();
    expect(screen.getByText(/^October 2026 · vs /)).toBeInTheDocument();
    expect(screen.queryByText(/cover only part of this period/)).not.toBeInTheDocument();
  });

  it("colours a change by the report's direction: down on a metric where up is good is bad", async () => {
    getReport.mockResolvedValue(doc(FULL));
    const { container } = render(await YourNumbers(props()));
    const chips = [...container.querySelectorAll(".rc-delta")].map((c) => c.className);
    expect(chips[0]).toContain("rc-delta--up-good"); // tasks, +3
    expect(chips[1]).toContain("rc-delta--down-bad"); // on time, -4pp
  });

  it("links to the same period of the person report", async () => {
    getReport.mockResolvedValue(doc(FULL));
    render(await YourNumbers(props({ period: "semester" })));
    expect(screen.getByRole("link", { name: "Open my report" })).toHaveAttribute("href", "/reports/person?periodKind=semester&start=2026-10-13");
  });

  it("says No data for a ratio over nothing and for a KPI the document lacks, and keeps the tiles it has", async () => {
    getReport.mockResolvedValue(doc([
      kpi("delivery.tasks_completed", 5, { delta: 1 }),
      kpi("delivery.on_time_rate", 0, { unit: "percent", numerator: 0, denominator: 0, delta: -0.3 }),
    ]));
    render(await YourNumbers(props()));
    expect(values()).toEqual(["5", "No data", "No data", "No data"]);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("0 h")).not.toBeInTheDocument();
  });

  it("shows the quiet note when the period starts before the records do, and no change against a period with none", async () => {
    getReport.mockResolvedValue(doc(FULL, { precedesFactHistory: { firstFactDate: "2026-05-01", affectedDays: 120 } }));
    const { container } = render(await YourNumbers(props({ period: "year" })));
    expect(screen.getByText(/cover only part of this period: records begin on 1 May 2026/)).toBeInTheDocument();
    expect(values()).toEqual(["12", "80%", "12.5 h", "9 of 10"]);
    expect(container.querySelectorAll(".rc-delta")).toHaveLength(0);
    expect(screen.queryByText(/ · vs /)).not.toBeInTheDocument();
  });

  it("throws when the read fails, and the frame's boundary says Unavailable, never 0 or No data", async () => {
    getReport.mockRejectedValue(new Error("down"));
    const failure = await YourNumbers(props()).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => { throw failure; };
    render(<WidgetBoundary title="Your numbers"><Boom /></WidgetBoundary>);
    expect(screen.getByRole("heading", { name: "Your numbers" })).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });
});

describe("Your numbers is registered (DW-3d)", () => {
  it("has a component, and no ticket, in every department workspace; My activity still does not render", () => {
    expect(hasOverviewWidget("your-numbers")).toBe(true);
    expect(OVERVIEW_WIDGETS["your-numbers"]).toBe(YourNumbers);
    const ctx = { me: person, tenantId: "co-a", unitPath: ["d-web"] };
    for (const ws of WORKSPACES.filter((w) => w.overview[0].key !== "decisions")) {
      const numbers = ws.overview.find((w) => w.key === "your-numbers")!;
      expect(numbers.ticket, ws.key).toBeUndefined();
      expect(isPlanned(numbers), ws.key).toBe(false);
      const activity = ws.overview.find((w) => w.key === "my-activity")!;
      expect(isPlanned(activity), ws.key).toBe(true);
      const you = selectBands(ws.overview, ctx, (key) => hasOverviewWidget(key)).find((b) => b.band === "you");
      expect(you?.widgets.map((w) => w.key), ws.key).toEqual(["your-numbers"]);
    }
  });

  it("is not in the company frame", () => {
    const company = WORKSPACES.find((w) => w.overview[0].key === "decisions")!;
    expect(company.overview.some((w) => w.key === "your-numbers")).toBe(false);
  });
});
