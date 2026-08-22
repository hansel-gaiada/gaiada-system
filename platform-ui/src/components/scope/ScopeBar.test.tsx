import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScopeBar } from "./ScopeBar";
import { wholeGroupOption, type ScopeAxisConfig } from "@/lib/scope";

const entity: ScopeAxisConfig = {
  key: "entity",
  param: "entity",
  label: "Entity",
  defaultValue: "all",
  options: [wholeGroupOption(), { value: "co-1", label: "Company One" }, { value: "co-2", label: "Company Two" }],
};

const period: ScopeAxisConfig = {
  key: "period",
  param: "period",
  label: "Period",
  defaultValue: "this-month",
  options: [{ value: "this-month", label: "This month" }, { value: "last-month", label: "Last month" }],
};

describe("ScopeBar", () => {
  it("renders nothing when the page declares no axes — surfaces opt in", () => {
    const { container } = render(<ScopeBar basePath="/rollups" searchParams={{}} axes={[]} />);
    expect(container.textContent).toBe("");
  });

  it("renders a pill per declared axis, defaulting to the axis's declared default", () => {
    render(<ScopeBar basePath="/rollups" searchParams={{}} axes={[entity, period]} />);
    expect(screen.getByText("Entity")).toBeTruthy();
    expect(screen.getByText("Period")).toBeTruthy();
    // Entity's default option is explicitly "Whole group" — the gap the spec calls out. `<details>`
    // renders its menu content in the DOM even while closed (jsdom applies no `display:none`
    // filtering the way a real browser's UA stylesheet would), so both the closed summary's current-
    // value label AND the menu's own "Whole group" link legitimately match — assert there are at
    // least that many, not exactly one.
    expect(screen.getAllByText(/Whole group/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows no active-filter count when every axis sits at its default", () => {
    render(<ScopeBar basePath="/rollups" searchParams={{}} axes={[entity, period]} />);
    expect(screen.queryByText(/filter.*active/i)).toBeNull();
  });

  it("counts and can reset axes that are off their default", () => {
    render(<ScopeBar basePath="/rollups" searchParams={{ entity: "co-1", period: "last-month" }} axes={[entity, period]} />);
    expect(screen.getByText(/2 filters active/i)).toBeTruthy();
    const reset = screen.getByRole("link", { name: "Reset" });
    expect(reset.getAttribute("href")).toBe("/rollups");
  });

  it("preserves unrelated query params through an axis link", () => {
    render(<ScopeBar basePath="/rollups" searchParams={{ q: "keep-me" }} axes={[entity]} />);
    const link = screen.getByRole("link", { name: "Company One" });
    expect(link.getAttribute("href")).toBe("/rollups?q=keep-me&entity=co-1");
  });

  it("renders a single-option axis as a quiet static label, not a dead disclosure", () => {
    const single: ScopeAxisConfig = { key: "currency", param: "currency", label: "Currency", defaultValue: "IDR", options: [{ value: "IDR", label: "IDR" }] };
    render(<ScopeBar basePath="/rollups" searchParams={{}} axes={[single]} />);
    expect(screen.queryByRole("group", { name: "Currency" })).toBeNull();
    expect(screen.getByText("IDR")).toBeTruthy();
  });
});
