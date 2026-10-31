"use client";
// SCP-5 W5-A4 (BFF §63.24.7): the Social reports page's kind switch (Daily, Weekly, Monthly, Quarterly, Half-year, Yearly, Other, showing only the kinds the company has on) and the period picker for the
// chosen kind. The switch is links (the kind is in the page's query, so the page is server-rendered for it); the picker is a select of the kind's recent periods plus "Any period", which navigates on change.
import Link from "next/link";
import { useId } from "react";
import { useRouter } from "next/navigation";
import { filtersHref } from "@/lib/socialReports";
import { KIND_TABS, type KindTab, type PeriodChoice } from "@/lib/socialReportKinds";
import "./cycles.css";
import "./reports.css";

export function ReportKindBar({ deptId, offered, tab, status, period, choices }: {
  deptId: string;
  offered: readonly KindTab[];
  tab: KindTab;
  status: string | null;
  period: string | null;
  /** The recent periods of the chosen kind; empty for Other, which has no period of its own. */
  choices: readonly PeriodChoice[];
}) {
  const uid = useId();
  const router = useRouter();
  // A period in the link that is not among the recent ones (an old report's) stays selectable, so the picker never lies about what the list is filtered to.
  const shown = period && !choices.some((c) => c.value === period) ? [{ value: period, label: period, ended: true }, ...choices] : choices;
  return (
    <div className="scp-reports__kinds">
      <nav className="scp-reports__filter" aria-label="Kind of report">
        <span>Kind</span>
        {KIND_TABS.filter((t) => offered.includes(t.key)).map((t) => (
          <Link key={t.key} className="scp-reports__chip" href={filtersHref(deptId, { kind: t.key, status, period: null })} aria-current={t.key === tab}>{t.label}</Link>
        ))}
      </nav>
      {tab !== "other" && (
        <div className="scp-field">
          <label htmlFor={`${uid}-period`}>Period</label>
          <select id={`${uid}-period`} className="scp-input" value={period ?? ""} onChange={(e) => router.push(filtersHref(deptId, { kind: tab, status, period: e.target.value || null }))}>
            <option value="">Any period</option>
            {shown.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
