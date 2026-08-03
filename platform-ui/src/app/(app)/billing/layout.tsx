import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// Module gate only — the pages below keep their own headers. Backed by the `billing` module
// (ModuleEnabledGuard("billing") on its controller), so with it off every read here 404s and the
// pages would render as legitimately-empty rather than unavailable.
export default async function BillingSectionLayout({ children }: { children: React.ReactNode }) {
  if (!(await isModuleOnForActiveCompany("billing"))) return <ModuleDisabled module="billing" label="Billing" />;
  return <>{children}</>;
}
