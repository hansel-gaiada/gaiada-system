import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TrendLine } from "./TrendLine";
import type { ReportSeries } from "@/lib/reports";

function dailySeries(key: string, label: string, n: number, startIso = "2026-01-01"): ReportSeries {
  const points = Array.from({ length: n }, (_, i) => {
    const d = new Date(`${startIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { t: d.toISOString().slice(0, 10), v: i + 1 };
  });
  return { key, label, unit: "count", kind: "line", points };
}

describe("TrendLine — x-axis bucketing scales to header.dayCount (§7)", () => {
  it("a 30-day series renders one fallback row per day (daily granularity)", () => {
    const s = dailySeries("activity", "Activity", 30);
    render(<TrendLine series={[s]} dayCount={30} title="Activity" />);
    // table rows = header + 30 daily buckets
    const table = screen.getByRole("table", { hidden: true });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(30);
  });

  it("a 90-day series buckets to weekly — far fewer rows than days", () => {
    const s = dailySeries("activity", "Activity", 90);
    render(<TrendLine series={[s]} dayCount={90} title="Activity" />);
    const table = screen.getByRole("table", { hidden: true });
    const rows = table.querySelectorAll("tbody tr").length;
    expect(rows).toBeLessThan(20); // ~13 ISO-week buckets over 90 days
    expect(rows).toBeGreaterThan(8);
  });

  it("a 400-day series buckets to ~13 monthly points — never 400", () => {
    const s = dailySeries("activity", "Activity", 400);
    render(<TrendLine series={[s]} dayCount={400} title="Activity" />);
    const table = screen.getByRole("table", { hidden: true });
    const rows = table.querySelectorAll("tbody tr").length;
    expect(rows).toBeLessThanOrEqual(15);
    expect(rows).toBeGreaterThanOrEqual(12);
  });

  it("carries role=img + a meaningful aria-label, and a visually-hidden fallback table", () => {
    const s = dailySeries("activity", "Activity", 10);
    render(<TrendLine series={[s]} dayCount={10} title="Activity" />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toMatch(/Activity/);
    expect(screen.getByRole("table", { hidden: true })).toBeInTheDocument();
  });

  it("shows a not-enough-history message instead of a degenerate chart with <2 points", () => {
    const s = dailySeries("activity", "Activity", 1);
    render(<TrendLine series={[s]} dayCount={1} title="Activity" />);
    expect(screen.getByText(/Not enough history yet/)).toBeInTheDocument();
  });
});

describe("TrendLine: a step series and a custom date wording (DW-10b)", () => {
  const monthly = (key: string, label: string, vs: (number | null)[]): ReportSeries => ({
    key, label, unit: "percent", kind: "line", points: vs.map((v, i) => ({ t: `2026-${String(i + 1).padStart(2, "0")}-01`, v })),
  });
  const pathsOf = (container: HTMLElement) => [...container.querySelectorAll("svg path")].map((p) => p.getAttribute("d") ?? "");

  it("draws a step series as horizontal-then-vertical segments, and a plain series as a slope", () => {
    const target = monthly("target", "Target", [0.8, 0.8, 0.9]);
    const slope = render(<TrendLine series={[target]} dayCount={365} title="T" unit="percent" />);
    const sloped = pathsOf(slope.container)[0];
    slope.unmount();
    const stepped = render(<TrendLine series={[target]} dayCount={365} title="T" unit="percent" stepKeys={["target"]} />);
    const d = pathsOf(stepped.container)[0];
    expect(sloped.match(/L/g)).toHaveLength(2); // M p0 L p1 L p2
    expect(d.match(/L/g)).toHaveLength(4); // each later point is reached by a hold, then a jump
    const ys = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(ys[1][1]).toBe(ys[0][1]); // the first move is horizontal
    expect(ys[2][0]).toBe(ys[1][0]); // the next is vertical, at the same x
  });

  it("breaks a step line at a null instead of holding the level across the gap", () => {
    const target = monthly("target", "Target", [0.8, null, 0.9, 0.9]);
    const { container } = render(<TrendLine series={[target]} dayCount={365} title="T" unit="percent" stepKeys={["target"]} />);
    expect(pathsOf(container)[0].match(/M/g)).toHaveLength(2);
  });

  it("words the date through formatDate in the table", () => {
    render(<TrendLine series={[monthly("v", "Value", [0.8, 0.9])]} dayCount={365} title="T" unit="percent" formatDate={(iso) => `month ${iso.slice(5, 7)}`} />);
    const rows = screen.getByRole("table", { hidden: true }).querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("month 01");
  });
});
