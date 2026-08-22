"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui";
import { Menu, MenuItem } from "@/components/overlay/Menu";
import { Pagination } from "./Pagination";
import { formatDate, formatDateTime } from "@/lib/format";
import "./data.css";

// Reusable, data-driven table: search + sortable columns + pagination + CSV
// export. Rows are PLAIN objects (no render functions) so a server component
// can pass them straight in. Composite cells: precompute a string field on the
// row and render it as "text". Pagination/sort/search are client-side over the
// provided rows — adequate for page-sized lists; server-side paging is a
// backend concern (see the BFF contract).
//
// Phase 4 extensions (§6 "DataTable — EXTEND"): sticky header with a scroll-under shadow, a
// column-visibility control, numeric right-alignment with tabular figures, row height sourced
// from the density token (`--row-height`, already density-aware via `[data-density]` in
// shell.css — no new prop needed here, the row just has to consume the token), and
// loading/error states alongside the pre-existing empty state. Every new prop is optional and
// every existing call site (9 pages) is unaffected.
type Fmt = "text" | "status" | "date" | "datetime" | "number";
export interface Column {
  key: string;
  header: string;
  align?: "right";
  sortable?: boolean;
  format?: Fmt;
  width?: string;
}

/** Row-selection wiring for a bulk-action bar. Selection is a controlled Set owned by the
 *  caller (a client wrapper around this table) so it survives DataTable's own internal
 *  sort/filter/page state changes and so a `BulkActionBar` rendered alongside can read it. */
export interface DataTableSelection {
  selectedIds: Set<string>;
  getRowId: (row: Record<string, unknown>) => string;
  onToggle: (id: string, checked: boolean) => void;
  /** `ids` is the CURRENT PAGE's row ids (post filter/sort) — "select all" only ever acts on
   *  what's visibly on screen, never on rows hidden by the active filter or a different page. */
  onToggleAll: (ids: string[], checked: boolean) => void;
}

interface Props {
  columns: Column[];
  rows: Record<string, unknown>[];
  link?: { base: string; idKey: string; labelKey: string };
  searchKeys?: string[];
  pageSize?: number;
  csvName?: string;
  empty?: string;
  /** Reserves the table's shape and shows shimmer rows instead of real data — for a client-side
   *  refetch (e.g. after a bulk action), not the initial server-rendered load (that case simply
   *  doesn't render DataTable yet; see BackendPending/ConnectionState for "no data at all"). */
  loading?: boolean;
  /** A read that failed after the table already mounted (e.g. a client-side refresh). Distinct
   *  from `empty`, which means the read succeeded and genuinely found nothing (§7.5's rule). */
  error?: string;
  /** Enables per-view persistence (visible columns + sort) to a small first-party cookie, so a
   *  reader's chosen columns survive a reload. Omit to keep the table stateless across reloads
   *  (existing call sites are unaffected either way — no cookie is written without this). */
  viewKey?: string;
  selection?: DataTableSelection;
}

function cellText(v: unknown, fmt?: Fmt): string {
  if (v == null || v === "") return fmt === "status" ? "" : "—";
  if (fmt === "date") return formatDate(String(v));
  if (fmt === "datetime") return formatDateTime(String(v));
  return String(v);
}

interface StoredView { hidden?: string[]; sortKey?: string | null; dir?: "asc" | "desc"; }

function readViewCookie(viewKey: string): StoredView | null {
  if (typeof document === "undefined") return null;
  const name = `dtview:${viewKey}=`;
  const hit = document.cookie.split("; ").find((c) => c.startsWith(name));
  if (!hit) return null;
  try {
    return JSON.parse(decodeURIComponent(hit.slice(name.length))) as StoredView;
  } catch {
    return null;
  }
}

function writeViewCookie(viewKey: string, view: StoredView) {
  if (typeof document === "undefined") return;
  document.cookie = `dtview:${viewKey}=${encodeURIComponent(JSON.stringify(view))}; path=/; max-age=31536000; samesite=lax`;
}

export function DataTable({
  columns, rows, link, searchKeys, pageSize = 15, csvName, empty = "Nothing here yet.",
  loading = false, error, viewKey, selection,
}: Props) {
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Restore a saved view AFTER mount, not during initial render — the server-rendered and
  // first-hydration passes must match (no cookie access exists on the server), so this is a
  // post-mount effect rather than a lazy useState initializer. A one-frame "all columns, default
  // sort" flash before the saved view applies is the accepted tradeoff for zero hydration risk.
  useEffect(() => {
    if (!viewKey) return;
    const saved = readViewCookie(viewKey);
    if (!saved) return;
    if (saved.hidden) setHidden(new Set(saved.hidden.filter((k) => columns.some((c) => c.key === k))));
    if (saved.sortKey && columns.some((c) => c.key === saved.sortKey)) setSortKey(saved.sortKey);
    if (saved.dir === "asc" || saved.dir === "desc") setDir(saved.dir);
    // Columns/viewKey identity is stable per mount for every real call site — re-running this on
    // every column-array re-creation would fight the user's own subsequent toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  useEffect(() => {
    if (!viewKey) return;
    writeViewCookie(viewKey, { hidden: [...hidden], sortKey, dir });
  }, [viewKey, hidden, sortKey, dir]);

  // Scroll-under shadow for the sticky header (design-language §10: "a 1px shadow/highlight
  // appears only once content has scrolled beneath it — no shadow at rest"). An
  // IntersectionObserver on a 1px sentinel works regardless of which ancestor actually scrolls
  // (the `.dt__scroll` wrapper only handles the horizontal axis; long tables scroll the page).
  // jsdom has no IntersectionObserver — guarded so every test using DataTable keeps working.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting), { threshold: 1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const visibleColumns = useMemo(() => columns.filter((c) => !hidden.has(c.key)), [columns, hidden]);
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

  const toggleColumn = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // Never hide every column — a table with zero columns is a bug dressed as a preference.
      if (next.size >= columns.length) return prev;
      return next;
    });
  };

  const exportCsv = () => {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const head = visibleColumns.map((c) => esc(c.header)).join(",");
    const body = filtered.map((r) => visibleColumns.map((c) => esc(cellText(r[c.key], c.format).replace("—", ""))).join(",")).join("\n");
    const blob = new Blob([`${head}\n${body}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${csvName ?? "export"}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const rowId = (r: Record<string, unknown>) => selection?.getRowId(r) ?? String(r[link?.idKey ?? "id"]);
  const pageIds = view.map(rowId);
  const allPageSelected = selection ? pageIds.length > 0 && pageIds.every((id) => selection.selectedIds.has(id)) : false;
  const somePageSelected = selection ? pageIds.some((id) => selection.selectedIds.has(id)) : false;
  const headCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headCheckboxRef.current) headCheckboxRef.current.indeterminate = somePageSelected && !allPageSelected;
  }, [somePageSelected, allPageSelected]);

  return (
    <div className="dt" aria-busy={loading || undefined}>
      <div className="dt__bar">
        <div className="dt__search">
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Filter…"
            aria-label="Filter rows"
            disabled={loading}
          />
        </div>
        <span className="dt__count">{filtered.length} {filtered.length === 1 ? "row" : "rows"}</span>
        <Menu
          label="Columns"
          align="end"
          trigger={(s) => (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-haspopup="menu" aria-expanded={s.open} onClick={s.toggle}>
              Columns
            </button>
          )}
        >
          {columns.map((c) => (
            <MenuItem key={c.key} checked={!hidden.has(c.key)} onClick={() => toggleColumn(c.key)}>
              {c.header}
            </MenuItem>
          ))}
        </Menu>
        {csvName && filtered.length > 0 && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={exportCsv}>Export CSV</button>
        )}
      </div>

      <div ref={sentinelRef} className="dt__sentinel" aria-hidden="true" />
      {error ? (
        <p className="dt__error" role="alert">{error}</p>
      ) : (
        <div className="dt__scroll">
          <table
            className={`dt__table${scrolled ? " dt__table--scrolled" : ""}`}
            style={{ "--dt-cols": (selection ? ["auto"] : []).concat(visibleColumns.map((c) => c.width ?? "1fr")).join(" ") } as React.CSSProperties}
          >
            <thead>
              <tr>
                {selection && (
                  <th className="dt__checkcell">
                    <input
                      ref={headCheckboxRef}
                      type="checkbox"
                      aria-label="Select all rows on this page"
                      checked={allPageSelected}
                      onChange={(e) => selection.onToggleAll(pageIds, e.target.checked)}
                      disabled={loading || pageIds.length === 0}
                    />
                  </th>
                )}
                {visibleColumns.map((c) => {
                  const numeric = c.format === "number";
                  const rightAlign = c.align === "right" || numeric;
                  return (
                    <th key={c.key} className={rightAlign ? "dt--right" : undefined}>
                      {c.sortable ? (
                        <button type="button" className="dt__sort" onClick={() => toggleSort(c.key)}>
                          {c.header}<span className="dt__arrow">{sortKey === c.key ? (dir === "asc" ? "▲" : "▼") : ""}</span>
                        </button>
                      ) : c.header}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: Math.min(pageSize, 5) }).map((_, i) => (
                  <tr key={`sk-${i}`} className="dt__skeleton-row" aria-hidden="true">
                    {(selection ? [null, ...visibleColumns] : visibleColumns).map((c, j) => (
                      <td key={c ? c.key : "sel"}>{j === 0 && selection ? null : <span className="dt__skeleton" />}</td>
                    ))}
                  </tr>
                ))
              ) : view.length === 0 ? (
                <tr><td className="dt__empty" colSpan={visibleColumns.length + (selection ? 1 : 0)}>{q ? "No rows match your filter." : empty}</td></tr>
              ) : view.map((r, i) => {
                const id = rowId(r);
                const isSelected = selection?.selectedIds.has(id) ?? false;
                return (
                  <tr key={id || i} className={isSelected ? "dt__row--selected" : undefined}>
                    {selection && (
                      <td className="dt__checkcell">
                        <input
                          type="checkbox"
                          aria-label={`Select row ${i + 1}`}
                          checked={isSelected}
                          onChange={(e) => selection.onToggle(id, e.target.checked)}
                        />
                      </td>
                    )}
                    {visibleColumns.map((c) => {
                      const numeric = c.format === "number";
                      const rightAlign = c.align === "right" || numeric;
                      const isLink = link && c.key === link.labelKey && r[link.idKey] != null;
                      const content = c.format === "status" && r[c.key]
                        ? <StatusBadge label={String(r[c.key])} />
                        : cellText(r[c.key], c.format);
                      return (
                        <td key={c.key} className={[rightAlign ? "dt--right" : "", numeric ? "dt--num" : ""].filter(Boolean).join(" ") || undefined}>
                          {isLink ? <Link href={`${link!.base}/${r[link!.idKey]}`} className="dt__link">{content}</Link> : content}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!error && (
        <Pagination
          page={clamped + 1}
          pageCount={pages}
          rangeStart={filtered.length === 0 ? 0 : clamped * pageSize + 1}
          rangeEnd={Math.min(clamped * pageSize + pageSize, filtered.length)}
          total={filtered.length}
          onPageChange={(p) => setPage(p - 1)}
        />
      )}
    </div>
  );
}
