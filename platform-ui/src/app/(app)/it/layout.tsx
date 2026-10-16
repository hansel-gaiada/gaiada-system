import { PageHeader } from "@/components/PageHeader";
import { HideOnOverview } from "@/components/overview/HideOnOverview";
import { SectionTabs } from "@/components/shell/SectionTabs";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ITModuleGate } from "@/components/it/ITModuleGate";

// IT is a functional department: same console pattern as Web Dev. This layout
// owns the header + tab strip; the tool pages (Overview / Devices / Topology /
// Workflows) render only their bodies. Device detail keeps its own header.
const TABS = [
  { key: "overview", label: "Overview", href: "/it", icon: "home" as const },
  { key: "devices", label: "Devices", href: "/it/devices", icon: "inventory" as const },
  { key: "topology", label: "Topology", href: "/it/topology", icon: "hub" as const },
  // Sits next to Topology on purpose: that tab answers "what devices exist", this one answers "who is
  // reaching the ERP, and can we stop it" (DW-7h: connected, sign-ins, alerts, blocks). Like Accounts it
  // works with the `it` module off (ITModuleGate).
  { key: "network", label: "Network", href: "/it/network", icon: "gateway" as const },
  { key: "workflows", label: "Workflows", href: "/it/workflows", icon: "automation" as const },
  // P2-14. Last because it is the newest, not because it matters least — a leaver who can still log in
  // is the most urgent thing this console reports.
  { key: "accounts", label: "Accounts", href: "/it/accounts", icon: "hr" as const },
];

export default async function ITConsoleLayout({ children }: { children: React.ReactNode }) {
  // ItController is ModuleEnabledGuard("it") — with the module off, devices/topology/workflows all
  // 404 and would render as an empty estate, which is exactly what a real empty estate looks like.
  const moduleOn = await isModuleOnForActiveCompany("it");
  return (
    <>
      {/* DW-3a: the Overview draws its own header. With the module off the page body is not the
          Overview, so the header stays. */}
      <HideOnOverview overviewPath="/it" enabled={moduleOn}>
        <PageHeader
          eyebrow="Department workspace"
          title="IT"
          subtitle="Device estate, topology and automation for the company."
          breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: "IT" }]}
        />
      </HideOnOverview>
      {/* The tab strip renders ALWAYS now: Accounts is reachable with the `it` module off (see
          ITModuleGate for why), so hiding the strip would hide the one tool that still works. The gate
          moved inside, per-tool. */}
      <SectionTabs tabs={TABS} />
      <ITModuleGate moduleOn={moduleOn}>{children}</ITModuleGate>
    </>
  );
}
