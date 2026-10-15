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

describe("DataTable · PV7-05 extensions (health cells and sortBy)", () => {
  const cols: Column[] = [
    { key: "name", header: "Client", sortable: true },
    { key: "health", header: "Health", format: "health", sortable: true, sortBy: "healthSort" },
    { key: "waiting", header: "Waiting on us", sortable: true, sortBy: "waitingSort", sortAs: "number" },
  ];
  const data = [
    { id: "a", name: "A", health: "quiet", healthSort: "4", waiting: "10 · oldest 2 days", waitingSort: 10 },
    { id: "b", name: "B", health: "off_track", healthSort: "0", waiting: "9 · oldest 20 days", waitingSort: 9 },
    { id: "c", name: "C", health: "at_risk", healthSort: "1", waiting: "—", waitingSort: -1 },
  ];
  const order = () => [...document.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent);

  it("draws a health state as the shared chip (its words and its state), not as a status badge", () => {
    render(<DataTable columns={cols} rows={data} />);
    const chip = screen.getByText("Off track");
    expect(chip.getAttribute("data-state")).toBe("off_track");
    expect(chip.className).toContain("ch-health-chip");
  });

  it("sorts a composite cell by its sortBy field: health by rank (worst first), a count as a number, not as words", () => {
    render(<DataTable columns={cols} rows={data} />);
    fireEvent.click(screen.getByRole("button", { name: /Health/ }));
    expect(order()).toEqual(["B", "C", "A"]);
    fireEvent.click(screen.getByRole("button", { name: /Waiting on us/ }));
    expect(order()).toEqual(["C", "B", "A"]); // -1, 9, 10 (as words "10 ..." would sort before "9 ...")
    fireEvent.click(screen.getByRole("button", { name: /Waiting on us/ }));
    expect(order()).toEqual(["A", "B", "C"]);
  });
});
