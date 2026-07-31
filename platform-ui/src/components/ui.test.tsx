import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Eyebrow, Card, Button, StatusBadge, statusColor, humanizeStatus, KpiTile, HairlineTable, Toast } from "./ui";
import { LineChart } from "./LineChart";

describe("ui primitives", () => {
  it("Eyebrow renders uppercase editorial class", () => {
    render(<Eyebrow>Workspace</Eyebrow>);
    expect(screen.getByText("Workspace")).toHaveClass("type-eyebrow");
  });

  it("Card renders title and children on the paper surface", () => {
    render(<Card title="Activity"><p>row</p></Card>);
    expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(screen.getByText("row")).toBeInTheDocument();
  });

  it("statusColor maps known statuses and falls back to the in-flight family", () => {
    expect(statusColor("Approved")).toBe("var(--status-ok-fg)");
    expect(statusColor("Overdue")).toBe("var(--status-critical-fg)");
    expect(statusColor("Anything else")).toBe("var(--status-progress-fg)");
  });

  it("statusColor maps raw backend enums (lowercase/underscored)", () => {
    expect(statusColor("active")).toBe("var(--status-ok-fg)");
    expect(statusColor("in_progress")).toBe("var(--status-progress-fg)");
    expect(statusColor("on_hold")).toBe("var(--status-critical-fg)");
  });

  it("statusColor still works for the Title-Case prototype labels", () => {
    expect(statusColor("Active")).toBe("var(--status-ok-fg)");
  });

  it("statusColor maps secret-presence badge states", () => {
    expect(statusColor("Configured")).toBe("var(--status-ok-fg)");
    expect(statusColor("Absent")).toBe("var(--status-idle-fg)");
  });

  it("humanizeStatus turns raw enums into a readable label", () => {
    expect(humanizeStatus("in_progress")).toBe("In progress");
    expect(humanizeStatus("on_hold")).toBe("On hold");
    expect(humanizeStatus("todo")).toBe("Todo");
  });

  it("StatusBadge displays the humanized label while coloring via statusColor", () => {
    render(<StatusBadge label="in_progress" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("KpiTile shows label, value and delta", () => {
    render(<KpiTile label="Approvals pending" value="8" delta="+3" deltaUp foot="since yesterday" />);
    expect(screen.getByText("Approvals pending")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText(/\+3/)).toBeInTheDocument();
  });

  it("HairlineTable renders columns and rows", () => {
    render(
      <HairlineTable
        columns={[{ label: "Item" }, { label: "Status", align: "right" }]}
        rows={[["Budget memo", <StatusBadge key="s" label="Pending" />]]}
      />,
    );
    expect(screen.getByText("Item")).toBeInTheDocument();
    expect(screen.getByText("Budget memo")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("LineChart renders an svg path from the series", () => {
    const { container } = render(<LineChart series={[1, 2, 3]} />);
    expect(container.querySelector("svg path")).not.toBeNull();
  });

  it("Button variants carry the luxury classes", () => {
    render(<Button variant="ghost" size="sm">New</Button>);
    expect(screen.getByRole("button", { name: "New" }).className).toContain("lux-btn--ghost");
  });

  it("Toast renders the message", () => {
    render(<Toast message="Approved — routed to finance" />);
    expect(screen.getByText("Approved — routed to finance")).toBeInTheDocument();
  });
});
