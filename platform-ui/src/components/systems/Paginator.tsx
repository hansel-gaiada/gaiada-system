"use client";
import { useEffect, useState } from "react";
import "./systems.css";

// The ONE client-side pagination control for the systems consoles (bot Chats/Logs/Controls tabs,
// Automation/Hub/Gateway list sections) — every long list pages through this, none hand-rolls its
// own prev/next. Page size is fixed at 30 across the board unless a caller has a specific reason
// to differ.
export const DEFAULT_PAGE_SIZE = 30;

export interface PaginationResult<T> {
  page: number;
  setPage: (page: number) => void;
  pageItems: T[];
  pageCount: number;
  total: number;
  /** 1-based index of the first item on the current page (0 when `total` is 0). */
  rangeStart: number;
  /** 1-based index of the last item on the current page. */
  rangeEnd: number;
}

/**
 * Slices `items` into pages of `pageSize`. `resetKey` is whatever identifies the CURRENT VIEW the
 * operator is paging through — a search term, an active filter, anything that means "this is a
 * different list than the one page N referred to a moment ago." Whenever `resetKey` changes, the
 * page snaps back to 1.
 *
 * Deliberately NOT keyed on `items` itself: for polling lists (the chat list refetches every 15s)
 * `items` gets a new array identity on every poll even though the operator's view hasn't changed,
 * and resetting the page under someone mid-read would be a worse bug than the one this hook
 * exists to prevent. Instead, `items` shrinking out from under the current page (e.g. the live
 * list lost a row) is handled by clamping below — every render, unconditionally — so a stale page
 * number pointing past the end can never be reached however the list changed.
 */
export function usePagination<T>(items: T[], pageSize: number = DEFAULT_PAGE_SIZE, resetKey?: unknown): PaginationResult<T> {
  const [page, setPageState] = useState(1);

  useEffect(() => {
    setPageState(1);
    // Only the reset key (the "which view is this" identity) should re-trigger this — see the
    // doc comment above for why `items`/`pageSize` are intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // Clamped every render (not just on reset): the one invariant this hook guarantees is that the
  // page in use always addresses real rows.
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const startIdx = (safePage - 1) * pageSize;
  const pageItems = items.slice(startIdx, startIdx + pageSize);

  return {
    page: safePage,
    setPage: (p: number) => setPageState(Math.min(Math.max(Math.trunc(p), 1), pageCount)),
    pageItems,
    pageCount,
    total,
    rangeStart: total === 0 ? 0 : startIdx + 1,
    rangeEnd: Math.min(startIdx + pageSize, total),
  };
}

export interface PaginatorProps {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPageChange: (page: number) => void;
}

/** Renders nothing when everything fits on one page — a paginator with no work to do is noise. */
export function Paginator({ page, pageCount, rangeStart, rangeEnd, total, onPageChange }: PaginatorProps) {
  if (pageCount <= 1) return null;

  return (
    <nav className="lux-paginator" aria-label="Pagination">
      <span className="lux-paginator__range">
        {rangeStart}–{rangeEnd} of {total}
      </span>
      <div className="lux-paginator__controls">
        <button
          type="button"
          className="lux-paginator__btn"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </button>
        <span className="lux-paginator__page" aria-current="page">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="lux-paginator__btn"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
