import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { FilterBar, FilterSearch } from "./FilterBar";

describe("FilterBar", () => {
  it("renders an All chip with the total count plus each option, marking the active one", () => {
    render(
      <FilterBar
        totalCount={12}
        active="active"
        options={[{ key: "active", label: "Active", count: 8 }, { key: "archived", label: "Archived", count: 4 }]}
        buildHref={(k) => (k ? `/clients?status=${k}` : "/clients")}
      />,
    );
    const all = screen.getByRole("link", { name: "All 12" });
    expect(all).toHaveAttribute("href", "/clients");
    const active = screen.getByRole("link", { name: "Active 8" });
    expect(active).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Archived 4" })).toHaveAttribute("href", "/clients?status=archived");
  });

  it("clicking the active chip's own href clears the filter (toggle-off)", () => {
    render(
      <FilterBar
        active="active"
        options={[{ key: "active", label: "Active", count: 8 }]}
        buildHref={(k) => (k ? `/clients?status=${k}` : "/clients")}
      />,
    );
    expect(screen.getByRole("link", { name: "Active 8" })).toHaveAttribute("href", "/clients");
  });

  it("FilterSearch renders a real GET form with no client JS required", () => {
    render(<FilterSearch action="/clients" label="Search clients" defaultValue="acme" />);
    const form = screen.getByRole("search");
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/clients");
    expect(screen.getByLabelText("Search clients")).toHaveValue("acme");
  });
});
