import { PageHeader } from "@/components/PageHeader";
import { SectionTabs } from "@/components/shell/SectionTabs";

// IT is a functional department: same console pattern as Web Dev. This layout
// owns the header + tab strip; the tool pages (Overview / Devices / Topology /
// Workflows) render only their bodies. Device detail keeps its own header.
const TABS = [
  { key: "overview", label: "Overview", href: "/it", icon: "home" as const },
  { key: "devices", label: "Devices", href: "/it/devices", icon: "inventory" as const },
  { key: "topology", label: "Topology", href: "/it/topology", icon: "hub" as const },
  { key: "workflows", label: "Workflows", href: "/it/workflows", icon: "automation" as const },
];

export default function ITConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader
        eyebrow="Department workspace"
        title="IT"
        subtitle="Device estate, topology and automation for the company."
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: "IT" }]}
      />
      <SectionTabs tabs={TABS} />
      {children}
    </>
  );
}
