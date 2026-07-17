"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";
import "./data.css";

// Reusable, data-driven table: search + sortable columns + pagination + CSV
// export. Rows are PLAIN objects (no render functions) so a server component
// can pass them straight in. Composite cells: precompute a string field on the
// row and render it as "text". Pagination/sort/search are client-side over the
// provided rows — adequate for page-sized lists; server-side paging is a
// backend concern (see the BFF contract).
type Fmt = "text" | "status" | "date" | "datetime" | "number";
export interface Column {
  key: string;
  header: string;
  align?: "right";
  sortable?: boolean;
  format?: Fmt;
  width?: string;
}
interface Props {
  columns: Column[];
  rows: Record<string, unknown>[];
  link?: { base: string; idKey: string; labelKey: string };
  searchKeys?: string[];
  pageSize?: number;
  csvName?: string;
  empty?: string;
}

function cellText(v: unknown, fmt?: Fmt): string {
  if (v == null || v === "") return fmt === "status" ? "" : "—";
  if (fmt === "date") return formatDate(String(v));
  if (fmt === "datetime") return formatDateTime(String(v));
  return String(v);
}

export function DataTable({ columns, rows, link, searchKeys, pageSize = 15, csvName, empty = "Nothing here yet." }: Props) {
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);

  const keys = searchKeys ?? columns.map((c) => c.key);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows;
    if (needle) out = rows.filter((r) => keys.some((k) => String(r[k] ?? "").toLowerCase().includes(needle)));
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      const numeric = col?.format === "number";
      const dated = col?.format === "date" || col?.format === "datetime";
      out = [...out].sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        let cmp: number;
        if (numeric) cmp = Number(av ?? 0) - Number(bv ?? 0);
        else if (dated) cmp = Date.parse(String(av ?? 0)) - Date.parse(String(bv ?? 0));
        else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
        return dir === "asc" ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, q, sortKey, dir, keys, columns]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clamped = Math.min(page, pages - 1);
  const view = filtered.slice(clamped * pageSize, clamped * pageSize + pageSize);

  const toggleSort = (k: string) => {
    if (sortKey === k) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setDir("asc"); }
    setPage(0);
  };

  const exportCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const head = columns.map((c) => esc(c.header)).join(",");
    const body = filtered.map((r) => columns.map((c) => esc(cellText(r[c.key], c.format).replace("—", ""))).join(",")).join("\n");
    const blob = new Blob([`${head}\n${body}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${csvName ?? "export"}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="dt">
      <div className="dt__bar">
        <div className="dt__search">
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Filter…" aria-label="Filter rows" />
        </div>
        <span className="dt__count">{filtered.length} {filtered.length === 1 ? "row" : "rows"}</span>
        {csvName && filtered.length > 0 && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={exportCsv}>Export CSV</button>
        )}
      </div>

      <div className="dt__scroll">
        <table className="dt__table" style={{ "--dt-cols": columns.map((c) => c.width ?? "1fr").join(" ") } as React.CSSProperties}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.align === "right" ? "dt--right" : undefined}>
                  {c.sortable ? (
                    <button type="button" className="dt__sort" onClick={() => toggleSort(c.key)}>
                      {c.header}<span className="dt__arrow">{sortKey === c.key ? (dir === "asc" ? "▲" : "▼") : ""}</span>
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.length === 0 ? (
              <tr><td className="dt__empty" colSpan={columns.length}>{q ? "No rows match your filter." : empty}</td></tr>
            ) : view.map((r, i) => (
              <tr key={String(r[link?.idKey ?? "id"] ?? i)}>
                {columns.map((c) => {
                  const isLink = link && c.key === link.labelKey && r[link.idKey] != null;
                  const content = c.format === "status" && r[c.key]
                    ? <StatusBadge label={String(r[c.key])} />
                    : cellText(r[c.key], c.format);
                  return (
                    <td key={c.key} className={c.align === "right" ? "dt--right" : undefined}>
                      {isLink ? <Link href={`${link!.base}/${r[link!.idKey]}`} className="dt__link">{content}</Link> : content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="dt__pager">
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={clamped === 0} onClick={() => setPage(clamped - 1)}>Prev</button>
          <span className="dt__pageinfo">Page {clamped + 1} of {pages}</span>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={clamped >= pages - 1} onClick={() => setPage(clamped + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
