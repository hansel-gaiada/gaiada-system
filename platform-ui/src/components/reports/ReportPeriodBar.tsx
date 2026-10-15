"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { PeriodSelector, type PeriodSelectorValue } from "./PeriodSelector";

// The period control for report pages that list people or departments rather than render one
// `ReportDocument` (DW-4b's /reports/team). It is `ReportPageClient`'s wiring without the viewer:
// the next {kind, start, end} goes into the URL (shareable, bookmarkable) and every other search
// param, notably `unit`, is kept, so changing the period never loses which department is open.
// DW-4k: `rp-noprint` (reports-print.css, loaded by the reports layout): the controls do not print; the
// page prints the period as text instead (`.rp-printonly`).
export function ReportPeriodBar({ value, todayIso }: { value: PeriodSelectorValue; todayIso: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function onChange(next: PeriodSelectorValue) {
    const params = new URLSearchParams(sp.toString());
    params.set("periodKind", next.kind);
    params.set("start", next.start);
    params.set("end", next.end);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="rp-noprint" style={{ margin: "0 0 16px" }}>
      <PeriodSelector value={value} onChange={onChange} todayIso={todayIso} />
    </div>
  );
}
