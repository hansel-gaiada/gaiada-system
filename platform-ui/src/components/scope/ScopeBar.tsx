import Link from "next/link";
import {
  currentAxisValue, isAxisDefault, activeAxisCount, axisHref, resetScopeHref,
  type ScopeAxisConfig, type ScopeSearchParams,
} from "@/lib/scope";
import "./scope.css";

// The scope bar (UI redesign §3/"the scope bar"): Entity · Department · Period · Currency exposed
// as REAL controls, not labels. Same zero-JS idiom ScopePill.tsx already established for the single
// company-scope case (native <details>/<summary> + plain <Link>s, so it degrades to ordinary
// navigation with no client JS at all) — generalised here to N independently-configured axes.
//
// Surfaces opt IN: a page builds the `axes` array for whatever it actually supports (see
// ScopeAxisConfig) and passes its own `searchParams` straight through. A page that builds no axes
// renders nothing — there is no default/global mounting of this bar in Shell.tsx, on purpose (most
// pages are single-company/single-department and have nothing for it to control).
export function ScopeBar({ basePath, searchParams, axes }: {
  basePath: string;
  searchParams: ScopeSearchParams;
  axes: ScopeAxisConfig[];
}) {
  if (axes.length === 0) return null;
  const activeCount = activeAxisCount(searchParams, axes);

  return (
    <div className="scope-bar" role="group" aria-label="View scope">
      {axes.map((axis) => (
        <ScopeAxisPill key={axis.key} basePath={basePath} searchParams={searchParams} axis={axis} />
      ))}
      {activeCount > 0 && (
        <span className="scope-bar__count">
          {activeCount} filter{activeCount === 1 ? "" : "s"} active
          <Link href={resetScopeHref(basePath, searchParams, axes)} className="scope-bar__reset">
            Reset
          </Link>
        </span>
      )}
    </div>
  );
}

function ScopeAxisPill({ basePath, searchParams, axis }: {
  basePath: string;
  searchParams: ScopeSearchParams;
  axis: ScopeAxisConfig;
}) {
  const value = currentAxisValue(searchParams, axis);
  const active = !isAxisDefault(searchParams, axis);
  const currentLabel = axis.options.find((o) => o.value === value)?.label ?? value;

  // A single-option axis has nothing to switch to — render the quiet static label the rest of the
  // shell already uses for "nothing to choose" (ScopePill's own precedent), not a dead disclosure.
  if (axis.options.length <= 1) {
    return (
      <span className="scope-bar__pill scope-bar__pill--static">
        <span className="scope-bar__label">{axis.label}</span>
        <span className="scope-bar__value">{currentLabel}</span>
      </span>
    );
  }

  return (
    <details className={`scope-bar__pill${active ? " scope-bar__pill--active" : ""}`}>
      <summary className="scope-bar__summary">
        <span className="scope-bar__label">{axis.label}</span>
        <span className="scope-bar__value">{currentLabel} ▾</span>
      </summary>
      {/* Plain disclosure content — a <nav> of ordinary links, same discipline ScopePill.tsx
          documents: this is NOT a fake ARIA menu, so it must not claim menu semantics it doesn't
          wire up. Tab moves through the links like any other list. */}
      <nav className="scope-bar__menu" aria-label={axis.label}>
        {axis.options.map((opt) => (
          <Link
            key={opt.value}
            href={axisHref(basePath, searchParams, axis, opt.value)}
            className={`scope-bar__item${value === opt.value ? " scope-bar__item--active" : ""}`}
            aria-current={value === opt.value ? "true" : undefined}
          >
            {opt.label}
          </Link>
        ))}
      </nav>
    </details>
  );
}
