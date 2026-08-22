"use client";
import "./data.css";

// Unified pagination control (Phase 4, EXTEND/unify — §6): `systems/Paginator.tsx` and
// `DataTable`'s own inline Prev/Next buttons were two independent implementations of the same
// idea. This is the shared control going forward — `DataTable` now renders it directly (see
// below). `systems/Paginator.tsx` is left as-is (out of this pass's file list, and its own
// `usePagination` hook has callers/tests depending on its exact shape) rather than migrated in
// the same PR that also changes DataTable's behaviour — a follow-up can point it at this
// component once both are proven identical in practice (risk register item 8: make the call
// explicitly, don't let re-skinning-in-place harden the divergence).
export interface PaginationProps {
  page: number;
  pageCount: number;
  rangeStart: number;
  rangeEnd: number;
  total: number;
  onPageChange: (page: number) => void;
}

/** Renders nothing when everything fits on one page — a pager with no work to do is noise. */
export function Pagination({ page, pageCount, rangeStart, rangeEnd, total, onPageChange }: PaginationProps) {
  if (pageCount <= 1) return null;
  return (
    <nav className="dt__pager" aria-label="Pagination">
      <span className="dt__pageinfo">{rangeStart}–{rangeEnd} of {total}</span>
      <div className="dt__pager-controls">
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Prev</button>
        <span className="dt__pageinfo" aria-current="page">Page {page} of {pageCount}</span>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Next</button>
      </div>
    </nav>
  );
}
