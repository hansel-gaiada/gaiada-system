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
