import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Productivity } from "./Productivity";
import type { ProductivityReport } from "@/lib/pm";

function day(date: string, total: number, over: Partial<Omit<ProductivityReport["series"][number], "date" | "total">> = {}) {
  return {
    date,
    completedTasks: 0, assignedCompleted: 0, involvedCompleted: 0, tasksAccepted: 0,
    reactionsGiven: 0, reactionsReceived: 0, notesContributions: 0, comments: 0,
    total,
    ...over,
  };
}

function makeReport(overrides: Partial<ProductivityReport> = {}): ProductivityReport {
  return {
    userId: "u-1",
    from: "2026-08-01",
    to: "2026-08-05",
    days: 5,
    series: [
      day("2026-08-01", 0),
      day("2026-08-02", 3, { completedTasks: 2, comments: 1 }),
      day("2026-08-03", 0),
      day("2026-08-04", 6, { completedTasks: 4, reactionsGiven: 2 }),
      day("2026-08-05", 1, { comments: 1 }),
    ],
    totals: {
      completedTasks: 6, assignedCompleted: 0, involvedCompleted: 0, tasksAccepted: 0,
      reactionsGiven: 2, reactionsReceived: 0, notesContributions: 0, comments: 2, total: 10,
    },
    score: null,
    scoreNote: "No composite score is computed. Decision 9 / P4-E1 has not been decided.",
    ...overrides,
  };
}

describe("Productivity", () => {
  // THE core acceptance bar for this ticket: a null score must render as an explicit absence, and
  // must NEVER be coerced to (or read as) 0 — a fabricated 0 looks like a real, bad measurement.
  it("renders a null score as an explicit absence, never as 0", () => {
    const { container } = render(<Productivity report={makeReport()} scopeName="Ada" viewingSelf />);
    const scoreValue = container.querySelector('[aria-label="No composite score is computed"]');
    expect(scoreValue).toBeTruthy();
    expect(scoreValue!.textContent).toBe("—");
    expect(container.textContent).not.toMatch(/Composite score[\s\S]{0,40}\b0\b/);
    // The explanatory note must actually be rendered (not just tucked into a hover-only tooltip).
    expect(container.textContent).toContain("No composite score is computed");
    expect(container.textContent).toContain("P4-E1");
  });

  it("still renders the score block honestly when totals are all zero (no activity != a zero score)", () => {
    const zeroReport = makeReport({
      series: [day("2026-08-01", 0), day("2026-08-02", 0)],
      totals: { completedTasks: 0, assignedCompleted: 0, involvedCompleted: 0, tasksAccepted: 0, reactionsGiven: 0, reactionsReceived: 0, notesContributions: 0, comments: 0, total: 0 },
      days: 2,
    });
    const { container } = render(<Productivity report={zeroReport} scopeName="Ada" viewingSelf />);
    expect(container.querySelector('[aria-label="No composite score is computed"]')!.textContent).toBe("—");
  });

  it("marks every component tile as appraisal-unsafe — none of this feeds appraisal scoring", () => {
    const { container } = render(<Productivity report={makeReport()} scopeName="Ada" viewingSelf />);
    // 8 components + total = 9 tiles, every one marked. The MARK moved out of a per-tile
    // `appraisal-unsafe` badge and into an inline `.rc-kpi__mark` explained once by
    // `.rc-kpis__legend` — on the live company report the badge was rendering eleven times, and
    // eleven grey boxes competed with the eleven figures they annotated (KpiTiles.tsx).
    // This assertion checks BOTH halves on purpose: nine marks with no legend would be nine
    // unexplained glyphs, which is a worse disclosure than the badge it replaced, and the point of
    // this test is the DISCLOSURE, not the markup that carries it.
    expect(container.querySelectorAll(".rc-kpi__mark").length).toBe(9);
    const legend = container.querySelectorAll(".rc-kpis__legend");
    expect(legend.length).toBe(1);
    expect(legend[0].textContent).toContain("not used in appraisal scoring");
  });

  it("zero-fills every day in the heatmap and never drops a day with no activity", () => {
    const { container } = render(<Productivity report={makeReport()} scopeName="Ada" viewingSelf />);
    const cells = container.querySelectorAll(".prod-heatmap__cell[data-level]");
    expect(cells.length).toBe(5); // one per day in the 5-day fixture range, no gaps
    const zeroLevelCells = [...cells].filter((c) => c.getAttribute("data-level") === "0");
    expect(zeroLevelCells.length).toBe(2); // 2026-08-01 and 2026-08-03 both have total: 0
  });

  it("gives the busiest day the top intensity level, relative to this range's own max", () => {
    const { container } = render(<Productivity report={makeReport()} scopeName="Ada" viewingSelf />);
    const busiest = container.querySelector('[aria-label^="04 Aug 2026"]');
    expect(busiest?.getAttribute("data-level")).toBe("4"); // total 6, the max in this fixture
  });

  it("names the reconciliation with Reports -> Person rather than silently forking a second number", () => {
    const { container } = render(<Productivity report={makeReport()} scopeName="Ada" viewingSelf />);
    expect(container.textContent).toContain("Reports");
    expect(container.textContent).toContain("delivery.tasks_completed");
    expect(container.textContent).toContain("nightly fact job");
  });
});
