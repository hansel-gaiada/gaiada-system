import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// Module gate only — the pages below keep their own headers. Backed by the `knowledge` module
// (ModuleEnabledGuard("knowledge") on its controller), so with it off every read here 404s and the
// pages would render as legitimately-empty rather than unavailable.
export default async function KnowledgeSectionLayout({ children }: { children: React.ReactNode }) {
  if (!(await isModuleOnForActiveCompany("knowledge"))) return <ModuleDisabled module="knowledge" label="Knowledge" />;
  return <>{children}</>;
}
