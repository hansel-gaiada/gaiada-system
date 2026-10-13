import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PeriodSelector } from "./PeriodSelector";
import { OVERVIEW_PERIOD_OPTIONS } from "@/lib/overview";

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: "/departments/d-web", search: "sscope=co-b" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

beforeEach(() => nav.replace.mockClear());

const button = (name: string) => screen.getByRole("button", { name });

describe("PeriodSelector", () => {
  it("is a labelled group of six buttons with the current period pressed", () => {
    render(<PeriodSelector value="month" />);
    expect(screen.getByRole("group", { name: "Period" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Today", "Week", "Month", "Quarter", "Semester", "Year"]);
    expect(button("Month")).toHaveAttribute("aria-pressed", "true");
    expect(button("Week")).toHaveAttribute("aria-pressed", "false");
  });

  it("shows a period the backend cannot report as disabled with its reason, and the rest as enabled", () => {
    render(<PeriodSelector value="month" />);
    // Which options are disabled comes from the registry, so this holds as report periods get built (DW-4a).
    for (const o of OVERVIEW_PERIOD_OPTIONS) {
      const b = button(o.label);
      if (o.disabledReason) {
        expect(b).toHaveAttribute("aria-disabled", "true");
        expect(b).toHaveAccessibleDescription(o.disabledReason);
      } else {
        expect(b).not.toHaveAttribute("aria-disabled");
      }
    }
    for (const name of ["Today", "Week", "Month"]) expect(button(name)).not.toHaveAttribute("aria-disabled");
  });

  it("writes ?period= to the URL and keeps the other params", () => {
    render(<PeriodSelector value="month" />);
    fireEvent.click(button("Week"));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith("/departments/d-web?sscope=co-b&period=week", { scroll: false });
  });

  it("does nothing when a disabled period is clicked", () => {
    render(<PeriodSelector value="month" />);
    for (const o of OVERVIEW_PERIOD_OPTIONS.filter((o) => o.disabledReason)) fireEvent.click(button(o.label));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("does not rewrite the URL for the period already chosen", () => {
    render(<PeriodSelector value="week" />);
    fireEvent.click(button("Week"));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("is made of native buttons, so the keyboard works, and a disabled period stays reachable to hear its reason", () => {
    render(<PeriodSelector value="month" />);
    for (const b of screen.getAllByRole("button")) {
      expect(b.tagName).toBe("BUTTON");
      expect(b).not.toBeDisabled();
      expect(b).toHaveAttribute("type", "button");
    }
  });
});
