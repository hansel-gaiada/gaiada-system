import Link from "next/link";
import "./scope.css";

// The shared scope selector (UX-2 §4.1) — one control reused by My Work,
// Approvals, Tasks, Calendar, and the department ServicedBlock (later
// tickets) as well as ORG-13's Connect-service / Serviced-functions surfaces.
// Server-component friendly: a pure href-builder means the parent decides how
// scope is persisted (a query param today; a cookie/pref later) and this
// component never needs "use client" — it's a <details>/<summary> menu of
// <Link>s, so it degrades to plain navigation with no JS at all.
export interface ScopePillProps {
  companies: { id: string; name: string }[]; // the caller's reachable set for THIS surface
  value: "all" | string; // current scope
  onChangeHref: (v: "all" | string) => string; // pure href builder
  countLabel?: string; // e.g. "5" or "3 served" — defaults to companies.length
  allLabel?: string; // defaults to "All companies"
}

export function ScopePill({ companies, value, onChangeHref, countLabel, allLabel = "All companies" }: ScopePillProps) {
  // Single reachable company -> a static label, no dropdown (matches the
  // existing canSwitchCompany / HrCompanyScope convention, UX-2 §4.3).
  if (companies.length <= 1) {
    return <span className="lux-badge scope-pill__static">{companies[0]?.name ?? "—"}</span>;
  }

  const count = countLabel ?? String(companies.length);
  const currentLabel = value === "all" ? `${allLabel} (${count})` : companies.find((c) => c.id === value)?.name ?? "Company";

  return (
    <details className="scope-pill">
      <summary className="scope-pill__summary">
        <span className="scope-pill__eyebrow">Scope</span>
        <span className="scope-pill__value">{currentLabel} ▾</span>
      </summary>
      <div className="scope-pill__menu" role="menu">
        <Link
          href={onChangeHref("all")}
          role="menuitem"
          className={`scope-pill__item${value === "all" ? " scope-pill__item--active" : ""}`}
        >
          {allLabel} ({count})
        </Link>
        {companies.map((c) => (
          <Link
            key={c.id}
            href={onChangeHref(c.id)}
            role="menuitem"
            className={`scope-pill__item${value === c.id ? " scope-pill__item--active" : ""}`}
          >
            {c.name}
          </Link>
        ))}
      </div>
    </details>
  );
}
