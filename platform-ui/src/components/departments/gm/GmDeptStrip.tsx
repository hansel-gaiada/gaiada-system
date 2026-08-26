import Link from "next/link";
import { HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import type { ReportOverviewScope } from "@/lib/reports-data";
import type { ReportKpi } from "@/lib/reports";

// Tier 2 of the GM cockpit: one row per department, the same headline figures side by side.
//
// This is the middle band of the three-tier exec layout — company health at the top, department
// summaries in the middle, drill-down at the bottom. It exists so the GM can see WHICH department
// moved a company number without opening four consoles.
//
// ── THE COLUMNS ARE DERIVED, NEVER HARDCODED ─────────────────────────────────────────────────────
// `reports/overview` returns each scope's own `kpis`, authored by the backend's metric registry per
// grain. This component reads the metric keys and labels out of the RESPONSE and builds columns from
// them. Hardcoding a column set here is precisely the frontend-first drift this program keeps
// getting bitten by: the registry adds or renames a metric, the console keeps asking for a key that
// no longer arrives, and `undefined` renders as a confident blank.
//
// The column set comes from the union across scopes (order-preserving, first appearance wins) rather
// than from `scopes[0]`: a department with no data for the period can legitimately come back with a
// shorter kpi list, and taking the first scope's list would then drop a column every other
// department has. A scope missing a metric renders "—", which is honest — it is not zero.
//
// `limit` caps the columns because this table is a SCAN, not the report. Anything past the cap is
// one click away in each department's own report; the caller says so rather than truncating
// silently.

/** Mirrors `charts/KpiTiles.tsx`'s own (private) `formatValue` — the same duplication the
 *  project/department report scope-picker pages already carry, and for the same reason: that helper
 *  is not exported and this is a table cell, not a tile. Keep the three in step. */
function formatKpiValue(k: ReportKpi): string {
  if (k.unit === "percent") return `${Math.round(k.value * 100)}%`;
  if (k.unit === "minutes") return `${Math.round(k.value).toLocaleString()}m`;
  return k.value.toLocaleString();
}

export interface GmDeptStripProps {
  scopes: ReportOverviewScope[];
  /** Max KPI columns to draw. */
  limit: number;
  /** Builds the drill-down href for one department scope. */
  hrefFor: (scopeRef: string) => string;
}

export function GmDeptStrip({ scopes, limit, hrefFor }: GmDeptStripProps) {
  if (scopes.length === 0) {
    return <EmptyNote>No department has report data for this period yet.</EmptyNote>;
  }

  // Union of metric keys across every scope, in first-appearance order.
  const metricOrder: string[] = [];
  const labelByKey = new Map<string, string>();
  for (const s of scopes) {
    for (const k of s.kpis) {
      if (!labelByKey.has(k.metricKey)) {
        labelByKey.set(k.metricKey, k.label);
        metricOrder.push(k.metricKey);
      }
    }
  }
  const shown = metricOrder.slice(0, limit);
  const hiddenCount = metricOrder.length - shown.length;

  const columns = [
    { label: "Department" },
    ...shown.map((key) => ({ label: labelByKey.get(key) ?? key, align: "right" as const })),
    // Right-aligned too, and NOT left. MEASURED in the browser: left-aligned, the link's left edge
    // sits flush against the right edge of the last right-aligned metric, and the row rendered as
    // "83%Open" with no gap between them. Pushing it to the far right puts the column's whole width
    // between the figure and the link.
    { label: "", align: "right" as const },
  ];

  const rows = scopes.map((s) => {
    const byKey = new Map(s.kpis.map((k) => [k.metricKey, k]));
    return [
      s.scopeName,
      ...shown.map((key) => {
        const k = byKey.get(key);
        // "—" not "0": a metric this department did not report is UNKNOWN, and a zero would be a
        // claim the console is not entitled to make.
        return k ? formatKpiValue(k) : "—";
      }),
      <Link key="go" href={hrefFor(s.scopeRef)} style={{ color: "var(--erp-accent)", textDecoration: "underline", textUnderlineOffset: 2 }}>
        Open
      </Link>,
    ];
  });

  return (
    <>
      {/* `minmax(96px, 1fr)`, not a bare `1fr`. MEASURED against the real metric registry during
          B4: the live grain returns labels like "THROUGHPUT WEIGHTED" and "TASKS COMPLETED", and at
          `1fr` those columns were narrower than their own headers, so "ON TIME RATE" and "TASKS
          COMPLETED" rendered on top of one another. The DEMO_MODE registry happened to return
          shorter labels, so this was invisible until the console met real data — the columns are
          derived, so their widths cannot be tuned to any one label set. */}
      <HairlineTable columns={columns} rows={rows} tcols={`1.6fr repeat(${shown.length}, minmax(96px, 1fr)) 0.5fr`} />
      {hiddenCount > 0 && (
        <p style={{ margin: "10px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" }}>
          {hiddenCount} further metric{hiddenCount === 1 ? "" : "s"} per department — open a department to see all of them.
        </p>
      )}
    </>
  );
}
