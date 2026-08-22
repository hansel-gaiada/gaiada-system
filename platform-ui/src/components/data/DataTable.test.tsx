import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DataTable, type Column } from "./DataTable";

const columns: Column[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "count", header: "Count", format: "number", sortable: true },
];
const rows = [
  { id: "1", name: "Beta", count: 5 },
  { id: "2", name: "Alpha", count: 20 },
];

describe("DataTable", () => {
  it("renders rows and honours the existing sortable/search/csv contract", () => {
    render(<DataTable columns={columns} rows={rows} searchKeys={["name"]} />);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter rows"), { target: { value: "Alpha" } });
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("shows the empty message when there are no rows, and a distinct 'no match' message when filtered to nothing", () => {
    render(<DataTable columns={columns} rows={[]} empty="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });

  it("numeric columns auto-right-align with tabular figures", () => {
    render(<DataTable columns={columns} rows={rows} />);
    const cell = screen.getByText("5");
    expect(cell.className).toContain("dt--num");
    expect(cell.className).toContain("dt--right");
  });

  it("sorts numerically, not lexically, for format: number columns", () => {
    render(<DataTable columns={columns} rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: /Count/ }));
    const cells = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[1].textContent);
    expect(cells).toEqual(["5", "20"]);
  });

  it("the Columns menu can hide a column, and never hides every column", () => {
    render(<DataTable columns={columns} rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Count" }));
    expect(screen.queryByRole("columnheader", { name: /Count/ })).toBeNull();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("renders a loading skeleton reserving the table shape, and marks the table busy", () => {
    const { container } = render(<DataTable columns={columns} rows={rows} loading />);
    expect(container.querySelector(".dt")).toHaveAttribute("aria-busy", "true");
    expect(container.querySelectorAll(".dt__skeleton").length).toBeGreaterThan(0);
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("renders an error state distinct from the empty state", () => {
    render(<DataTable columns={columns} rows={[]} error="Could not load rows." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load rows.");
  });

  it("wires row and select-all checkboxes to the controlled selection callbacks", () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        selection={{
          selectedIds: new Set(["1"]),
          getRowId: (r) => String(r.id),
          onToggle,
          onToggleAll,
        }}
      />,
    );
    expect(screen.getByLabelText("Select row 1")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Select row 2"));
    expect(onToggle).toHaveBeenCalledWith("2", true);
    fireEvent.click(screen.getByLabelText("Select all rows on this page"));
    expect(onToggleAll).toHaveBeenCalledWith(["1", "2"], true);
  });
});
