import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// Module gate only — the pages below keep their own headers. Backed by the `clients` module
// (ModuleEnabledGuard("clients") on its controller), so with it off every read here 404s and the
// pages would render as legitimately-empty rather than unavailable.
export default async function ClientsSectionLayout({ children }: { children: React.ReactNode }) {
  if (!(await isModuleOnForActiveCompany("clients"))) return <ModuleDisabled module="clients" label="Clients" />;
  return <>{children}</>;
}
