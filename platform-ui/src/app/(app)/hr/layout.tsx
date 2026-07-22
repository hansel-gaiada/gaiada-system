import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs, type SectionTab } from "@/components/shell/SectionTabs";

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
    // Org structure is edited on the company org builder; HR is its main consumer.
    ...(tenant ? [{ key: "org", label: "Org structure", href: `/companies/${tenant}/org`, icon: "inventory" as const }] : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Department workspace"
        title="HR"
        subtitle="People, roles and the company org structure."
        breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: "HR" }]}
      />
      <SectionTabs tabs={tabs} />
      {children}
    </>
  );
}
