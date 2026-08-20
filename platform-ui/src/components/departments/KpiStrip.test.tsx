import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { KpiStrip } from "./KpiStrip";

describe("KpiStrip", () => {
  it("renders all four KPIs with their values", () => {
    render(<KpiStrip active={12} dueSoon={3} blocked={2} progressPct={64} totalTasksFoot="of 24 total" totalProjectsFoot="across 6 projects" />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Due soon")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Progress")).toBeInTheDocument();
    // The unit is its own element (dept-kpi__unit) so it can be set below the numeral's weight,
    // hence the numeral and the "%" are asserted separately.
    expect(screen.getByText("64")).toBeInTheDocument();
    expect(screen.getByText("%")).toHaveClass("dept-kpi__unit");
  });

  it("gives every tile a bar slot so the four captions share one baseline", () => {
    const { container } = render(<KpiStrip active={1} dueSoon={0} blocked={0} progressPct={50} />);
    expect(container.querySelectorAll(".dept-kpi__bar")).toHaveLength(4);
    expect(container.querySelectorAll(".dept-kpi__bar--empty")).toHaveLength(3);
  });

  it("states what Blocked is made of when the caller passes the project spread", () => {
    const { rerender } = render(<KpiStrip active={0} dueSoon={0} blocked={1} progressPct={0} blockedProjects={1} />);
    expect(screen.getByText("1 task, 1 project")).toBeInTheDocument();
    rerender(<KpiStrip active={0} dueSoon={0} blocked={4} progressPct={0} blockedProjects={2} />);
    expect(screen.getByText("4 tasks, 2 projects")).toBeInTheDocument();
    // No spread passed → the generic line, never a wrong count.
    rerender(<KpiStrip active={0} dueSoon={0} blocked={4} progressPct={0} />);
    expect(screen.getByText("needs a look")).toBeInTheDocument();
  });

  it("only colours Blocked as attention when it is greater than zero", () => {
    const { rerender } = render(<KpiStrip active={1} dueSoon={0} blocked={0} progressPct={50} />);
    expect(screen.getByText("none right now").parentElement?.querySelector(".dept-kpi__value")).not.toHaveClass("dept-kpi__value--attention");
    rerender(<KpiStrip active={1} dueSoon={0} blocked={4} progressPct={50} />);
    expect(screen.getByText("4")).toHaveClass("dept-kpi__value--attention");
  });
});
