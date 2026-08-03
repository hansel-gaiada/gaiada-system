import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// Module gate only — no header/tabs of its own, so /agency and its children keep rendering their
// own PageHeaders exactly as before. AgencyController is ModuleEnabledGuard("agency"): with the
// module off, campaigns/assets/approvals all 404 and the pages would show an empty agency.
export default async function AgencySectionLayout({ children }: { children: React.ReactNode }) {
  if (!(await isModuleOnForActiveCompany("agency"))) return <ModuleDisabled module="agency" label="Agency" />;
  return <>{children}</>;
}
