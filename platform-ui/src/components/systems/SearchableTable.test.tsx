import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SearchableTable } from "./SearchableTable";

interface Row {
  id: string;
  name: string;
  status: string;
}

function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${i + 1}`,
    name: `Workflow ${i + 1}`,
    status: i === 0 ? "special-alpha" : "active",
  }));
}

const COLUMNS = [{ label: "Name" }, { label: "Status" }];
const renderRow = (r: Row) => [r.name, r.status];
const getSearchText = (r: Row) => `${r.name} ${r.status} ${r.id}`;

describe("SearchableTable", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the empty state (not a search box) when there are no items at all", () => {
    render(
      <SearchableTable
        items={[]}
        columns={COLUMNS}
        renderRow={renderRow}
        getSearchText={getSearchText}
        searchLabel="Search workflows"
        emptyState={<p>Nothing here at all.</p>}
      />,
    );
    expect(screen.getByText("Nothing here at all.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("paginates a 214-row list at 30 per page and shows the range", () => {
    render(
      <SearchableTable
        items={rows(214)}
        columns={COLUMNS}
        renderRow={renderRow}
        getSearchText={getSearchText}
        searchLabel="Search workflows"
        emptyState={<p>Nothing here at all.</p>}
      />,
    );
    expect(screen.getByText("Workflow 1")).toBeInTheDocument();
    expect(screen.queryByText("Workflow 31")).not.toBeInTheDocument();
    expect(screen.getByText("1–30 of 214")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Workflow 31")).toBeInTheDocument();
    expect(screen.queryByText("Workflow 1")).not.toBeInTheDocument();
  });

  it("renders no paginator at all when everything fits on one page", () => {
    render(
      <SearchableTable
        items={rows(10)}
        columns={COLUMNS}
        renderRow={renderRow}
        getSearchText={getSearchText}
        searchLabel="Search workflows"
        emptyState={<p>Nothing here at all.</p>}
      />,
    );
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
  });

  it("debounces the search box, then narrows the list and resets to page 1", async () => {
    vi.useFakeTimers();
    render(
      <SearchableTable
        items={rows(214)}
        columns={COLUMNS}
        renderRow={renderRow}
        getSearchText={getSearchText}
        searchLabel="Search workflows"
        emptyState={<p>Nothing here at all.</p>}
      />,
    );

    // Page to page 2 first (items 31-60).
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Workflow 31")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search workflows" }), {
      target: { value: "special-alpha" },
    });

    // Still within the debounce window — old page-2 contents remain, unfiltered.
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText("Workflow 31")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Filtered down to the one row with status "special-alpha" (Workflow 1), and back on page 1.
    expect(screen.getByText("Workflow 1")).toBeInTheDocument();
    expect(screen.queryByText("Workflow 31")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 214")).toBeInTheDocument();
  });

  it("shows a distinct 'no matches' empty state when a search matches nothing, keeping the search box visible", async () => {
    vi.useFakeTimers();
    render(
      <SearchableTable
        items={rows(5)}
        columns={COLUMNS}
        renderRow={renderRow}
        getSearchText={getSearchText}
        searchLabel="Search workflows"
        emptyState={<p>Nothing here at all.</p>}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search workflows" }), {
      target: { value: "no-such-thing" },
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText(/No results match/)).toBeInTheDocument();
    expect(screen.getByText(/no-such-thing/)).toBeInTheDocument();
    // Distinct from "nothing here at all" — the search box itself stays present so it can be adjusted.
    expect(screen.getByRole("searchbox", { name: "Search workflows" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing here at all.")).not.toBeInTheDocument();
  });
});
