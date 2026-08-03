import { PageHeader } from "@/components/PageHeader";
import { SectionTabs } from "@/components/shell/SectionTabs";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// IT is a functional department: same console pattern as Web Dev. This layout
// owns the header + tab strip; the tool pages (Overview / Devices / Topology /
// Workflows) render only their bodies. Device detail keeps its own header.
const TABS = [
  { key: "overview", label: "Overview", href: "/it", icon: "home" as const },
  { key: "devices", label: "Devices", href: "/it/devices", icon: "inventory" as const },
  { key: "topology", label: "Topology", href: "/it/topology", icon: "hub" as const },
  { key: "workflows", label: "Workflows", href: "/it/workflows", icon: "automation" as const },
];

export default async function ITConsoleLayout({ children }: { children: React.ReactNode }) {
  // ItController is ModuleEnabledGuard("it") — with the module off, devices/topology/workflows all
  // 404 and would render as an empty estate, which is exactly what a real empty estate looks like.
  const moduleOn = await isModuleOnForActiveCompany("it");
  return (
    <>
      <PageHeader
        eyebrow="Department workspace"
        title="IT"
        subtitle="Device estate, topology and automation for the company."
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: "IT" }]}
      />
      {moduleOn ? (
        <>
          <SectionTabs tabs={TABS} />
          {children}
        </>
      ) : (
        <ModuleDisabled module="it" label="IT" />
      )}
    </>
  );
}
