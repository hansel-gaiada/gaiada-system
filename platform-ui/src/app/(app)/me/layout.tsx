import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { PageHeader } from "@/components/PageHeader";
import { SectionTabs, type SectionTab } from "@/components/shell/SectionTabs";

// `/me` — the personal hub (employee-portal wave A).
//
// DESIGN DECISION (owner, 2026-08-05): this is a SECTION of the staff ERP, not a separate portal
// shell like `/portal`. Clients get their own interface because they are outsiders with no ERP
// identity; an employee already IS an ERP user, so a second shell would mean two navigations, two
// session surfaces and two places for "my stuff" to live. What was missing was not a shell — it was
// a HOME. Before this, the seven self-service surfaces an employee needs were scattered across
// Workspace / Business / Reports / Appraisals / account settings with no single entry point.
//
// EMPLOYEE PORTAL IS NOT UNDER HR (owner, 2026-08-04): HR manages employees to the extent HR needs;
// this section is what the employee themselves owns. That is why it sits at the top level next to
// Workspace rather than under /hr, and why the tabs below deliberately point OUT to the existing
// surfaces (/timesheets, /reports/person, /appraisals/mine) instead of re-implementing them — one
// implementation, reachable from where the employee looks for it.
//
// NOT module-gated as a whole, on purpose: Overview and Inbox work for every employee in every
// company, while Leave and Loans need the `hr` module (dark today on Sanur Resort and the holding
// company — only the agency has it enabled). Those two pages carry their own ModuleDisabled note, so
// an employee of a company without HR still gets a working personal hub instead of a wall.
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const tabs: SectionTab[] = [
    { key: "overview", label: "Overview", href: "/me", icon: "home" },
    { key: "inbox", label: "Inbox", href: "/me/inbox", icon: "check" },
    { key: "leave", label: "Leave", href: "/me/leave", icon: "clock" },
    { key: "loans", label: "Loans", href: "/me/loans", icon: "wallet" },
    // HR-FULL (2026-08-24). Ungated on purpose: the page asks the backend for "mine" and passes no
    // subject, and resource_hr_payroll.yaml's member arm answers with this person's own PUBLISHED
    // payslips or nothing. An employee with no payslips sees an empty state explaining why, which is
    // a better answer than a missing tab that looks like the feature does not exist.
    { key: "pay", label: "Pay", href: "/me/pay", icon: "finance" },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Personal"
        title="Me"
        subtitle="Everything that is yours — your requests, your record, your inbox."
      />
      <SectionTabs tabs={tabs} />
      {children}
    </>
  );
}
