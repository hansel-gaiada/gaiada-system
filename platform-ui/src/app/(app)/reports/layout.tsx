import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";
import "@/components/reports/reports-print.css";

// Module gate only — the pages below keep their own headers. Backed by the `reports` module
// (ModuleEnabledGuard("reports") on its controller), so with it off every read here 404s and the
// pages would render as legitimately-empty rather than unavailable.
//
// DW-4k: `rp-reports` is the hook the print stylesheet hangs off (`components/reports/reports-print.css`):
// every page below prints without the shell, whichever branch it rendered (a report, a roster, a picker).
export default async function ReportsSectionLayout({ children }: { children: React.ReactNode }) {
  if (!(await isModuleOnForActiveCompany("reports"))) return <ModuleDisabled module="reports" label="Reports" />;
  return <div className="rp-reports">{children}</div>;
}
