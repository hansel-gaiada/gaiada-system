import Link from "next/link";
import "./data.css";

// Unified filter bar (Phase 4, NEW per §6): `OriginFilterBar` (components/approvals/),
// `FilterChips` (components/dashboard/) and PM's `FacetFilters` are three-to-four bespoke,
// non-shared implementations of "chips that filter a list via the URL." This is the ONE
// primitive new list-page work should reach for — a plain href-builder, server-component
// friendly like its predecessors (no client JS required for the common single-facet case), over
// the same `{key, label, count}` shape `FilterChipDef` already established.
//
// PM's `FacetFilters` (multi-group, checkbox-driven) is deliberately NOT folded in here — it is
// PM-scoped and frozen through Phase 3 (§2.7) — this covers the single-facet chip-row case that
// covers the other three call sites' actual need.
export interface FilterOption {
  key: string;
  label: string;
  count?: number;
}

export function FilterBar({
  options,
  active,
  buildHref,
  label = "Filter",
  allLabel = "All",
  totalCount,
}: {
  options: FilterOption[];
  active: string | undefined;
  buildHref: (next: string | undefined) => string;
  label?: string;
  allLabel?: string;
  /** Count shown on a leading "All" chip. Omit to skip that chip (e.g. every real case is
   *  already covered by the option list). */
  totalCount?: number;
}) {
  return (
    <div className="fb" role="group" aria-label={label}>
      {totalCount !== undefined && (
        <Link
          href={buildHref(undefined)}
          className={`fb__chip${active === undefined ? " fb__chip--active" : ""}`}
          aria-current={active === undefined ? "true" : undefined}
        >
          <span className="fb__label">{allLabel}</span>
          <span className="fb__count">{totalCount}</span>
        </Link>
      )}
      {options.map((o) => {
        const isActive = active === o.key;
        return (
          <Link
            key={o.key}
            href={buildHref(isActive ? undefined : o.key)}
            className={`fb__chip${isActive ? " fb__chip--active" : ""}`}
            aria-current={isActive ? "true" : undefined}
          >
            <span className="fb__label">{o.label}</span>
            {o.count !== undefined && <span className="fb__count">{o.count}</span>}
          </Link>
        );
      })}
    </div>
  );
}

// Zero-JS text search companion — a real GET form, per the house convention (§4.2's "the bare
// <form action="/search"> remains functional as the palette's zero-JS fallback" is the same
// idea applied here: a filter bar's search box should work with JS disabled too).
export function FilterSearch({
  name = "q",
  defaultValue,
  placeholder = "Search…",
  action,
  label,
}: {
  name?: string;
  defaultValue?: string;
  placeholder?: string;
  action: string;
  label: string;
}) {
  return (
    <form className="fb__search" action={action} method="get" role="search">
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={label}
        className="fb__search-input"
      />
      <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Search</button>
    </form>
  );
}
