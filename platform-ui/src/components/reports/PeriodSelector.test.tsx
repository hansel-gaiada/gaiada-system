import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PeriodSelector, type PeriodSelectorValue } from "./PeriodSelector";

const BASE: PeriodSelectorValue = { kind: "month", start: "2026-07-01", end: "2026-07-30" };

describe("PeriodSelector — Daily/Weekly/Monthly/Custom (§7 amendment)", () => {
  it("clicking Daily/Weekly re-anchors the kind without opening the custom popover", () => {
    const onChange = vi.fn();
    render(<PeriodSelector value={BASE} onChange={onChange} todayIso="2026-07-30" />);
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "week", start: "2026-07-30", end: "2026-07-30" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the custom-range popover with preset rows", () => {
    render(<PeriodSelector value={BASE} onChange={vi.fn()} todayIso="2026-07-30" />);
    fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Last 7 days/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Last 30 days/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Last 90 days/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /This quarter/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Last quarter/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Year to date/ })).toBeInTheDocument();
  });

  it("clicking a preset emits kind=custom with that preset's exact range and closes the popover", () => {
    const onChange = vi.fn();
    render(<PeriodSelector value={BASE} onChange={onChange} todayIso="2026-07-30" />);
    fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
    fireEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    expect(onChange).toHaveBeenCalledWith({ kind: "custom", start: "2026-07-01", end: "2026-07-30" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a custom range over 400 days shows the range_too_large message and disables Apply", () => {
    render(<PeriodSelector value={BASE} onChange={vi.fn()} todayIso="2026-07-30" />);
    fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
    const start = screen.getByLabelText("Start");
    const end = screen.getByLabelText("End");
    fireEvent.change(start, { target: { value: "2025-01-01" } });
    fireEvent.change(end, { target: { value: "2026-07-30" } });
    expect(screen.getByText(/maximum custom range is 400 days/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("an end date before the start date is flagged invalid", () => {
    render(<PeriodSelector value={BASE} onChange={vi.fn()} todayIso="2026-07-30" />);
    fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-07-20" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-07-10" } });
    expect(screen.getByText(/End date must be on or after/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
