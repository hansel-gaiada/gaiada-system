import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MonthsView } from "./MonthsView";
import type { DeptKpiMonthCell, DeptKpiMonthsKpi, DeptKpiMonthsView } from "@/lib/deptKpiFormat";

// DW-10b-2 (BFF section 58.4): the By month table. Every cell says its value in the KPI's unit, the target in force under it, and its condition as a WORD
// (never colour alone); an unavailable cell says why; the current month is marked "so far"; each KPI can open a trend.

const MONTHS = ["2026-07", "2026-08", "2026-09", "2026-10"];
const view = (kpis: DeptKpiMonthsKpi[]): DeptKpiMonthsView => ({
  unit: { id: "dept-1", name: "Web Dev" }, workspace: "web-dev",
  months: MONTHS.map((month, i) => ({ month, start: `${month}-01`, end: `${month}-28`, partial: i === 3, condition: "at_risk" })),
  kpis,
});
const c = (month: string, over: Partial<DeptKpiMonthCell> = {}): DeptKpiMonthCell => ({
  month, value: 0.81, target: 0.85, tolerance: 0.05, targetSource: "approved", condition: "at_risk", ...over,
});
const onTime: DeptKpiMonthsKpi = {
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good",
  cells: [
    c("2026-07", { value: 0.9, target: 0.82, condition: "on_track" }),
    c("2026-08", { value: null, condition: "unavailable", reason: "no_data" }),
    c("2026-09", { value: 0.6, condition: "off_track" }),
    c("2026-10", { value: 0.81, condition: "at_risk" }),
  ],
};
const sla: DeptKpiMonthsKpi = {
  key: "requests-within-sla", label: "Requests delivered by the date needed", unit: "percent", direction: "up_good",
  cells: MONTHS.map((m) => c(m, { value: 0.93, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason: "no_target" })),
};
const uptime: DeptKpiMonthsKpi = {
  key: "client-site-uptime", label: "Client site uptime", unit: "percent", direction: "up_good",
  cells: MONTHS.map((m) => c(m, { value: null, target: null, tolerance: null, targetSource: "none", condition: "unavailable", reason: "no_reader" })),
};
const minutes: DeptKpiMonthsKpi = {
  key: "turnaround", label: "Client approval turnaround", unit: "minutes", direction: "down_good",
  cells: MONTHS.map((m, i) => c(m, { value: 90 + i * 30, target: 2880, condition: "on_track" })),
};
const counts: DeptKpiMonthsKpi = {
  key: "assets", label: "Assets delivered", unit: "count", direction: "up_good",
  cells: MONTHS.map((m, i) => c(m, { value: 1200 + i, target: 1000, condition: "on_track" })),
};

const row = (name: string) => screen.getByRole("row", { name: new RegExp(`^${name}`) });

describe("the By month table", () => {
  it("is an accessible table: a caption, column headers per month and a row header per KPI", () => {
    render(<MonthsView view={view([onTime, sla])} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText(/Web Dev: each KPI by month, Jul 2026 to Oct 2026, oldest first/)).toBeInTheDocument();
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["KPI", "Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026 so far"]);
    expect(within(table).getAllByRole("columnheader").every((h) => h.getAttribute("scope") === "col")).toBe(true);
    expect(within(table).getAllByRole("rowheader").map((h) => [h.textContent, h.getAttribute("scope")])).toEqual([
      ["Projects on time", "row"], ["Requests delivered by the date needed", "row"],
    ]);
  });

  it("marks only the current month as so far, and scrolls inside its own container", () => {
    render(<MonthsView view={view([onTime])} />);
    expect(screen.getAllByText("so far")).toHaveLength(1);
    const scroll = screen.getByRole("region", { name: /scrolls sideways/ });
    expect(scroll).toContainElement(screen.getByRole("table"));
    expect(scroll).toHaveAttribute("tabindex", "0");
  });

  it("shows the value in the KPI's unit, the target in force under it, and the condition as a word, per month", () => {
    render(<MonthsView view={view([onTime])} />);
    const cells = within(row("Projects on time")).getAllByRole("cell");
    expect(cells).toHaveLength(4);
    expect(cells[0].textContent).toBe("90%target 82%On track");
    expect(cells[2].textContent).toBe("60%target 85%Off track");
    expect(cells[3].textContent).toBe("81%target 85%At risk");
  });

  it("uses a different target per month when the series says so (each month against its own)", () => {
    render(<MonthsView view={view([onTime])} />);
    const cells = within(row("Projects on time")).getAllByRole("cell");
    expect(within(cells[0]).getByText("target 82%")).toBeInTheDocument();
    expect(within(cells[3]).getByText("target 85%")).toBeInTheDocument();
  });

  it("words minutes as a duration and counts with separators", () => {
    render(<MonthsView view={view([minutes, counts])} />);
    expect(within(row("Client approval turnaround")).getAllByRole("cell").map((x) => x.textContent)).toEqual([
      "1h 30mtarget 2 dOn track", "2htarget 2 dOn track", "2h 30mtarget 2 dOn track", "3htarget 2 dOn track",
    ]);
    expect(within(row("Assets delivered")).getAllByRole("cell")[0].textContent).toBe("1,200target 1,000On track");
  });

  it("says why a cell is unavailable, in the page's reason words, and a dash for a value it does not have", () => {
    render(<MonthsView view={view([onTime, sla, uptime])} />);
    const aug = within(row("Projects on time")).getAllByRole("cell")[1];
    expect(aug.textContent).toBe("—target 85%Unavailable · No data this period");
    const noTarget = within(row("Requests delivered by the date needed")).getAllByRole("cell")[0];
    expect(noTarget.textContent).toBe("93%no targetUnavailable · No target yet");
    const noReader = within(row("Client site uptime")).getAllByRole("cell")[2];
    expect(noReader.textContent).toBe("—no targetUnavailable · Not measured yet");
  });

  it("never carries a condition by colour alone: every dot is hidden from assistive tech and sits beside its word", () => {
    const { container } = render(<MonthsView view={view([onTime, sla])} />);
    const dots = container.querySelectorAll(".dk-dot");
    expect(dots.length).toBe(8);
    for (const dot of dots) {
      expect(dot.getAttribute("aria-hidden")).toBe("true");
      expect(dot.textContent).toBe("");
      expect((dot.parentElement?.textContent ?? "").length).toBeGreaterThan(5); // the word is in the same element
    }
  });

  it("reads a month the server left out as unavailable, never as a zero", () => {
    const sparse: DeptKpiMonthsKpi = { ...onTime, cells: [onTime.cells[0], onTime.cells[3]] };
    render(<MonthsView view={view([sparse])} />);
    const cells = within(row("Projects on time")).getAllByRole("cell");
    expect(cells).toHaveLength(4);
    expect(cells[1].textContent).toBe("—Unavailable");
    expect(cells[2].textContent).toBe("—Unavailable");
  });

  it("says so, in words, when there are no KPIs or no months", () => {
    render(<MonthsView view={view([])} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/no KPIs or no months to show/)).toBeInTheDocument();
  });
});

describe("the trend under the table", () => {
  it("is closed until a KPI's button opens it, and each KPI opens and closes on its own", () => {
    render(<MonthsView view={view([onTime, minutes])} />);
    expect(screen.queryByRole("img")).toBeNull();
    const open = screen.getByRole("button", { name: "Show the trend for Projects on time" });
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    const trend = screen.getByRole("img", { name: /Projects on time by month/ });
    expect(trend).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide the trend for Projects on time" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Show the trend for Client approval turnaround" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Hide the trend for Projects on time" }));
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws the values and the target as a step line, with months in its data table and a gap as a dash", () => {
    const { container } = render(<MonthsView view={view([onTime])} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the trend for Projects on time" }));
    expect(screen.getByRole("list", { name: "Series" })).toHaveTextContent("Projects on timeTarget");
    const paths = [...container.querySelectorAll("svg path")].map((p) => p.getAttribute("d") ?? "");
    expect(paths).toHaveLength(2);
    expect(paths[1].match(/L/g)?.length).toBeGreaterThanOrEqual(4); // the target steps
    const table = screen.getByRole("table", { name: "Projects on time by month, as a table", hidden: true });
    const rows = [...table.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((t) => t.textContent));
    expect(rows).toEqual([["Jul 2026", "90%", "82%"], ["Aug 2026", "—", "85%"], ["Sep 2026", "60%", "85%"], ["Oct 2026", "81%", "85%"]]);
    expect(screen.getByText(/latest month is month to date/)).toBeInTheDocument();
  });

  it("draws no target line when no month has a target, and says so", () => {
    const noTargets: DeptKpiMonthsKpi = { ...onTime, cells: onTime.cells.map((x) => ({ ...x, target: null, tolerance: null, targetSource: "none" as const })) };
    const { container } = render(<MonthsView view={view([noTargets])} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the trend for Projects on time" }));
    expect(container.querySelectorAll("svg path")).toHaveLength(1);
    expect(screen.getByText(/No month has a target yet/)).toBeInTheDocument();
  });

  it("says there is not enough to draw, instead of one lonely point, when fewer than two months have a value", () => {
    const { container } = render(<MonthsView view={view([uptime, { ...onTime, cells: [onTime.cells[0], ...onTime.cells.slice(1).map((x) => ({ ...x, value: null }))] }])} />);
    fireEvent.click(screen.getByRole("button", { name: "Show the trend for Client site uptime" }));
    expect(screen.getByText(/not enough months with a value to draw a trend for Client site uptime/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the trend for Projects on time" }));
    expect(screen.getByText(/not enough months with a value to draw a trend for Projects on time/)).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });
});
