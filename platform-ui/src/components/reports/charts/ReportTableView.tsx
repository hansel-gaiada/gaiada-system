import type { ReportTable } from "@/lib/reports";
import "./charts.css";

// A plain `ReportTable` renderer using the kit's OWN rc-* tokens. Deliberately
// NOT the existing generic `HairlineTable` (components/ui.tsx): that
// component's cell colors are hardcoded ink values (`rgba(26,25,22,.65)`)
// with no dark step — reusing it here left this exact table invisible
// (dark-on-dark) once its containing card flips to the kit's dark surface
// (caught by rendering the viewer in dark mode during TR-16's own QA pass).
// Fixing HairlineTable itself is a site-wide ui.css change, out of this
// ticket's scope — this local, dark-safe table keeps the kit correct on its
// own rather than depending on that broader fix landing first.
// TR-17 fix: a `unit: "percent"` column (e.g. `per_person`/`department_portfolio`'s `onTimeRate`,
// §6.1's `ReportTable.columns[].unit`) carries its value as a raw 0-1 FRACTION, same convention as
// every other percent value in the document (`ReportKpi.value`, `ReportSeries` points) — but this
// component was rendering it verbatim ("0.86") instead of formatting it ("86%"), the one column
// type in the kit that actually needed unit-aware formatting to read correctly. Found by actually
// rendering a department report in a browser (ruling 1) sitting right next to `KpiTiles`, which
// DOES format the same on-time-rate number as "82%" a few rows up — the raw fraction read as an
// obvious inconsistency, not just a style nit. `count`/`minutes`/`score` columns are left as plain
// numbers (their header label already carries the unit, e.g. "Throughput (min)" — the existing,
// harmless convention every non-percent column here already uses) and `text` passes through
// unchanged — only `percent` was actively misleading.
function formatCell(value: string | number | null | undefined, unit?: ReportTable["columns"][number]["unit"]): string {
  if (value === null || value === undefined) return "—";
  if (unit === "percent" && typeof value === "number") return `${Math.round(value * 100)}%`;
  return String(value);
}

export function ReportTableView({ table }: { table: ReportTable }) {
  return (
    <div className="rc-rtable" style={{ ["--rc-rtable-cols" as string]: `repeat(${table.columns.length}, 1fr)` }}>
      <div className="rc-rtable__head">
        {table.columns.map((c) => (
          <span key={c.key} className={c.align === "right" ? "rc-rtable__cell--right" : undefined}>{c.label}</span>
        ))}
      </div>
      {table.rows.map((row, i) => (
        <div className="rc-rtable__row" key={i}>
          {table.columns.map((c) => (
            <span key={c.key} className={c.align === "right" ? "rc-rtable__cell--right" : undefined}>
              {formatCell(row[c.key], c.unit)}
            </span>
          ))}
        </div>
      ))}
      {table.totalRow && (
        <div className="rc-rtable__row rc-rtable__row--total">
          {table.columns.map((c) => (
            <span key={c.key} className={c.align === "right" ? "rc-rtable__cell--right" : undefined}>
              {formatCell(table.totalRow?.[c.key], c.unit)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
