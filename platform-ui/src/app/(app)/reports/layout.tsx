import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// Module gate only — the pages below keep their own headers. Backed by the `reports` module
// (ModuleEnabledGuard("reports") on its controller), so with it off every read here 404s and the
// pages would render as legitimately-empty rather than unavailable.
export default async function ReportsSectionLayout({ children }: { children: React.ReactNode }) {
  if (!(await isModuleOnForActiveCompany("reports"))) return <ModuleDisabled module="reports" label="Reports" />;
  return <>{children}</>;
}
