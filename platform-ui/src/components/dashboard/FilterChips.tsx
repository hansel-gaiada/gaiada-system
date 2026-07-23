import Link from "next/link";
import "./dashboard.css";

export type QueueFilter = "overdue" | "due_today" | "approvals" | "mentions";

export interface FilterChipDef {
  key: QueueFilter;
  label: string;
  count: number;
}

// Command Center's KPI tiles, reborn as clickable filters (UX-2 §1.2: "KPI
// tiles become clickable filter chips that filter the queue below, not
// static vanity numbers"). Server-component friendly like ScopePill: a pure
// href-builder, no client JS required — clicking a chip just navigates to
// `?filter=`, and clicking the active chip again clears it (toggle).
export function FilterChips({ chips, active, buildHref }: {
  chips: FilterChipDef[];
  active: QueueFilter | undefined;
  buildHref: (next: QueueFilter | undefined) => string;
}) {
  return (
    <div className="filter-chips" role="group" aria-label="Filter your queue">
      {chips.map((c) => {
        const isActive = active === c.key;
        return (
          <Link
            key={c.key}
            href={buildHref(isActive ? undefined : c.key)}
            className={`filter-chip${isActive ? " filter-chip--active" : ""}`}
            aria-current={isActive ? "true" : undefined}
          >
            <span className="filter-chip__label">{c.label}</span>
            <span className="filter-chip__count">{c.count}</span>
          </Link>
        );
      })}
    </div>
  );
}
