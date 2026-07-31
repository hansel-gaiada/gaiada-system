import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReportTableView } from "./ReportTableView";
import type { ReportTable } from "@/lib/reports";

// TR-17 fix, found by the Playwright visual pass (ruling 1): a `unit: "percent"` column carries a
// raw 0-1 fraction (same convention as every other percent value in the document), but the table
// was rendering it verbatim ("0.86") right next to `KpiTiles` formatting the identical number as
// "82%" a few rows up — an obvious, misleading inconsistency once actually seen in a browser.
describe("ReportTableView — percent columns format as a percentage, never a raw fraction", () => {
  const table: ReportTable = {
    key: "per_person", label: "Per-person summary",
    columns: [
      { key: "person", label: "Person", unit: "text", align: "left" },
      { key: "throughput", label: "Throughput (min)", unit: "minutes", align: "right" },
      { key: "onTimeRate", label: "On-time rate", unit: "percent", align: "right" },
    ],
    rows: [{ person: "Made Putra", throughput: 980, onTimeRate: 0.86 }],
    totalRow: { person: "Total", throughput: 980, onTimeRate: 0.86 },
  };

  it("formats a percent cell as a rounded percentage, not the raw fraction", () => {
    render(<ReportTableView table={table} />);
    expect(screen.getAllByText("86%").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.86")).not.toBeInTheDocument();
  });

  it("leaves non-percent numeric columns as plain numbers (the header label already carries the unit)", () => {
    render(<ReportTableView table={table} />);
    expect(screen.getAllByText("980").length).toBeGreaterThan(0);
  });

  it("renders a missing cell as an em dash, not `undefined`/`null`", () => {
    const sparse: ReportTable = { ...table, rows: [{ person: "Nobody" }] };
    render(<ReportTableView table={sparse} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
