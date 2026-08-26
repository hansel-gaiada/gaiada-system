import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// Module gate only — the pages below keep their own headers. Backed by the `invoice` module
// (ModuleEnabledGuard("invoice") on its controller), so with it off every read here 404s and the
// pages would render as legitimately-empty rather than unavailable.
export default async function InvoiceSectionLayout({ children }: { children: React.ReactNode }) {
  if (!(await isModuleOnForActiveCompany("invoice"))) return <ModuleDisabled module="invoice" label="Invoices" />;
  return <>{children}</>;
}
