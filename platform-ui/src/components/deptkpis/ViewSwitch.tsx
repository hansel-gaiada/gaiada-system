import Link from "next/link";
import "./deptKpis.css";

// DW-10b-2 (BFF §58.4): the "This period | By month" switch on the department KPI page. The view is a URL parameter (`view=months`), like `?cycle=`, so
// it is shareable and survives a reload. Both links keep `unit` (and the period the page was opened on, so going to By month and back lands where the
// viewer was). It is a plain pair of links: a server component with no state, and the current view is `aria-current`.
export type KpiPageView = "period" | "months";

export function kpiViewHref(unit: string, view: KpiPageView, period: { periodKind?: string; start?: string; end?: string } = {}): string {
  const qs = new URLSearchParams({ unit });
  if (view === "months") qs.set("view", "months");
  if (period.periodKind) qs.set("periodKind", period.periodKind);
  if (period.start) qs.set("start", period.start);
  if (period.end) qs.set("end", period.end);
  return `/appraisals/department?${qs.toString()}`;
}

export function ViewSwitch({
  unit, view, period,
}: {
  unit: string;
  view: KpiPageView;
  /** The period params the page was opened with (only those that were given). */
  period?: { periodKind?: string; start?: string; end?: string };
}) {
  const items: { view: KpiPageView; label: string }[] = [
    { view: "period", label: "This period" },
    { view: "months", label: "By month" },
  ];
  return (
    <nav className="dk-switch" aria-label="KPI view">
      {items.map((it) => (
        <Link
          key={it.view} href={kpiViewHref(unit, it.view, period)} className={`dk-switch__link${it.view === view ? " dk-switch__link--on" : ""}`}
          aria-current={it.view === view ? "page" : undefined}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}
