import Link from "next/link";
import type { ApprovalOrigin } from "@/lib/approvalsShared";
import { ORIGINS, ORIGIN_LABEL } from "@/lib/approvalsShared";
import "../dashboard/dashboard.css";

// UX-2 §2.1/§2.2 — origin facet chips (All/Agency/Pipeline/HR/Automation/
// Agent). Server-component friendly like `FilterChips` (its Home sibling): a
// pure href-builder, no client JS needed for the common case.
export function OriginFilterBar({
  counts,
  total,
  active,
  buildHref,
}: {
  counts: Record<ApprovalOrigin, number>;
  total: number;
  active: ApprovalOrigin | undefined;
  buildHref: (next: ApprovalOrigin | undefined) => string;
}) {
  return (
    <div className="filter-chips" role="group" aria-label="Filter by origin">
      <Link href={buildHref(undefined)} className={`filter-chip${active === undefined ? " filter-chip--active" : ""}`}>
        <span className="filter-chip__label">All</span>
        <span className="filter-chip__count">{total}</span>
      </Link>
      {ORIGINS.filter((o) => counts[o] > 0 || active === o).map((o) => (
        <Link
          key={o}
          href={buildHref(active === o ? undefined : o)}
          className={`filter-chip${active === o ? " filter-chip--active" : ""}`}
        >
          <span className="filter-chip__label">{ORIGIN_LABEL[o]}</span>
          <span className="filter-chip__count">{counts[o]}</span>
        </Link>
      ))}
    </div>
  );
}
