"use client";
import { useMemo, useState, type ReactNode } from "react";
import { HairlineTable, Eyebrow } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { Paginator, usePagination, DEFAULT_PAGE_SIZE } from "./Paginator";
import { useDebouncedValue } from "./useDebouncedValue";
import "@/components/forms/forms.css";
import "./systems.css";

// Client-side search + pagination wrapper around HairlineTable, for the long lists on the
// Automation/Hub/Gateway consoles. Those pages are server components — the data (workflows,
// executions, hub tools/resources/prompts/audit, gateway providers/egress-audit/tenant-spend)
// already arrives from the server in full on page load; this component only decides what subset
// of an already-fetched array is rendered. No new fetch, no backend change.
export interface SearchableTableColumn {
  label: string;
  align?: "right";
}

export interface SearchableTableProps<T> {
  /** The full, already-fetched list. */
  items: T[];
  columns: SearchableTableColumn[];
  /** Same row-cell contract as HairlineTable's `rows` — one array of cells per item. */
  renderRow: (item: T, index: number) => ReactNode[];
  /** Plain-text haystack searched against (lowercased, substring match). */
  getSearchText: (item: T) => string;
  /** Accessible name for the search input, e.g. "Search workflows". */
  searchLabel: string;
  searchPlaceholder?: string;
  /** Shown instead of the search box + table when `items` is empty to begin with. */
  emptyState: ReactNode;
  pageSize?: number;
  tcols?: string;
}

export function SearchableTable<T>({
  items,
  columns,
  renderRow,
  getSearchText,
  searchLabel,
  searchPlaceholder,
  emptyState,
  pageSize = DEFAULT_PAGE_SIZE,
  tcols,
}: SearchableTableProps<T>) {
  const [queryInput, setQueryInput] = useState("");
  const debouncedQuery = useDebouncedValue(queryInput, 300);
  const trimmed = debouncedQuery.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!trimmed) return items;
    return items.filter((item) => getSearchText(item).toLowerCase().includes(trimmed));
  }, [items, trimmed, getSearchText]);

  // Reset key is the applied (debounced) search term — NOT `items`/`filtered` themselves, so this
  // stays correct even if a caller's `items` prop identity changes for reasons unrelated to search.
  const { page, setPage, pageItems, pageCount, total, rangeStart, rangeEnd } = usePagination(filtered, pageSize, trimmed);

  // "Nothing here at all" (no search box shown — there's nothing to search) is a different state
  // from "your search matched nothing" (box stays visible so the operator can adjust it).
  if (items.length === 0) return <>{emptyState}</>;

  return (
    <div className="sys-searchable">
      <div className="sys-searchable__toolbar">
        <label className="sys-searchable__label">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{searchLabel}</Eyebrow>
          <input
            type="search"
            className="lux-field__control"
            aria-label={searchLabel}
            placeholder={searchPlaceholder ?? "Filter…"}
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
          />
        </label>
        <span className="sys-searchable__count">
          {trimmed ? `${total} of ${items.length}` : `${items.length}`}
        </span>
      </div>

      {total === 0 ? (
        <EmptyNote>No results match &ldquo;{debouncedQuery.trim()}&rdquo;.</EmptyNote>
      ) : (
        <>
          <HairlineTable columns={columns} rows={pageItems.map((item, i) => renderRow(item, i))} tcols={tcols} />
          <Paginator
            page={page}
            pageCount={pageCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={total}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}
