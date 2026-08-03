import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs, type SectionTab } from "@/components/shell/SectionTabs";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// HR is a functional department, same console pattern as Web Dev / IT. Its tools:
// the people directory and the company org structure. This layout owns the header
// + tabs; tool pages render their bodies.
export default async function HRConsoleLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const tabs: SectionTab[] = [
    { key: "overview", label: "Overview", href: "/hr", icon: "home" },
    { key: "people", label: "People", href: "/hr/people", icon: "hr" },
    { key: "leave", label: "Leave", href: "/hr/leave", icon: "clock" },
    { key: "attendance", label: "Attendance", href: "/hr/attendance", icon: "check" },
    { key: "onboarding", label: "Onboarding", href: "/hr/onboarding", icon: "box" },
    { key: "cases", label: "Cases", href: "/hr/cases", icon: "inventory" },
    // Org structure is edited on the company org builder; HR is its main consumer.
    ...(tenant ? [{ key: "org", label: "Org structure", href: `/companies/${tenant}/org`, icon: "inventory" as const }] : []),
  ];

  // Every /api/:t/modules/hr/* route 404s while the module is off, so the tabs would lead to
  // pages that render as "no leave requests / no cases" — the header stays, the tools do not.
  const moduleOn = await isModuleOnForActiveCompany("hr");

  return (
    <>
      <PageHeader
        eyebrow="Department workspace"
        title="HR"
        subtitle="People, roles and the company org structure."
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: "HR" }]}
      />
      {moduleOn ? (
        <>
          <SectionTabs tabs={tabs} />
          {children}
        </>
      ) : (
        <ModuleDisabled module="hr" label="HR" />
      )}
    </>
  );
}
