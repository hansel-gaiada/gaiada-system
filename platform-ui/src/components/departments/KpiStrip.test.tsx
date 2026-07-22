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
    expect(screen.getByText("64%")).toBeInTheDocument();
  });

  it("only colours Blocked as attention when it is greater than zero", () => {
    const { rerender } = render(<KpiStrip active={1} dueSoon={0} blocked={0} progressPct={50} />);
    expect(screen.getByText("none right now").parentElement?.querySelector(".dept-kpi__value")).not.toHaveClass("dept-kpi__value--attention");
    rerender(<KpiStrip active={1} dueSoon={0} blocked={4} progressPct={50} />);
    expect(screen.getByText("4")).toHaveClass("dept-kpi__value--attention");
  });
});
