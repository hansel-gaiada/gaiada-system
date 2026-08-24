import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs, type SectionTab } from "@/components/shell/SectionTabs";
import { isModuleOnForActiveCompany } from "@/lib/modules";
import { can } from "@/lib/rbac";
import { ModuleDisabled } from "@/components/ModuleDisabled";

// HR is a functional department, same console pattern as Web Dev / IT. Its tools:
// the people directory and the company org structure. This layout owns the header
// + tabs; tool pages render their bodies.
export default async function HRConsoleLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  // HR-FULL (2026-08-24) widened this console from six tabs to twelve. Two of them are GATED rather
  // than always-on, and the gating is not cosmetic:
  //
  //   Compensation / Payroll — `hr.payroll.view`, which hr_staff deliberately does NOT hold. Showing
  //   an HR assistant a Payroll tab that 403s teaches them the console is broken; omitting it tells
  //   them the truth, which is that the salary book is a tier above their own.
  //
  // Everything else is ungated because its backend read is genuinely open to the HR reader tier.
  // Note the pre-existing ⚠ recorded in the blueprint: the HR NAV ENTRY itself is still ungated in
  // `components/shell/nav.ts`, so every staff member can open this console. That predates this
  // change and remains a product call, not fixed here — but the two money tabs below do not widen it.
  const canPayroll = can(me, "hr.payroll.view", tenant);
  const tabs: SectionTab[] = [
    { key: "overview", label: "Overview", href: "/hr", icon: "home" },
    { key: "people", label: "People", href: "/hr/people", icon: "hr" },
    { key: "leave", label: "Leave", href: "/hr/leave", icon: "clock" },
    { key: "attendance", label: "Attendance", href: "/hr/attendance", icon: "check" },
    { key: "onboarding", label: "Onboarding", href: "/hr/onboarding", icon: "box" },
    { key: "cases", label: "Cases", href: "/hr/cases", icon: "inventory" },
    { key: "recruitment", label: "Recruitment", href: "/hr/recruitment", icon: "hr" },
    { key: "reviews", label: "Reviews", href: "/hr/reviews", icon: "check" },
    ...(canPayroll
      ? [
          { key: "compensation", label: "Compensation", href: "/hr/compensation", icon: "wallet" as const },
          { key: "payroll", label: "Payroll", href: "/hr/payroll", icon: "finance" as const },
        ]
      : []),
    { key: "compliance", label: "Compliance", href: "/hr/compliance", icon: "inventory" },
    { key: "analytics", label: "Analytics", href: "/hr/analytics", icon: "pulse" },
    { key: "settings", label: "Settings", href: "/hr/settings", icon: "box" },
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
        subtitle="People, hiring, pay, compliance and the company org structure."
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
