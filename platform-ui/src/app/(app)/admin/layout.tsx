import { notFound, redirect } from "next/navigation";
import { SectionTabs } from "@/components/shell/SectionTabs";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { adminRouteAllowed } from "@/lib/adminAccess";
import "@/components/admin/admin.css";

// Settings (formerly "Admin"). Its sub-sections are in-page tabs here rather than
// separate sidebar entries; each page renders its own header + content below.
const TABS = [
  { key: "users", label: "Users & Roles", href: "/admin/users", icon: "hr" as const },
  { key: "identity", label: "Identity Links", href: "/admin/identity", icon: "hub" as const },
  { key: "modules", label: "Modules & Fields", href: "/admin/modules", icon: "box" as const },
  // ORG-13 — propose→accept lifecycle for shared-service connections; renders
  // an empty/quiet state whenever SERVICE_ASSIGNMENTS_ENABLED is off.
  { key: "services", label: "Services", href: "/admin/services", icon: "hub" as const },
  { key: "compliance", label: "Compliance", href: "/admin/compliance", icon: "check" as const },
  { key: "audit", label: "Audit", href: "/admin/audit", icon: "clock" as const },
  // MAIL-15 — sent-mail log + inbound threads (design §8A).
  { key: "mail", label: "Mail", href: "/admin/mail", icon: "hub" as const },
  // Software information: deployed app version + each service's reported build (VERSIONING.md).
  { key: "about", label: "About", href: "/admin/about", icon: "pulse" as const },
];

// DW-D20: offer only the tabs the person may open, so nobody is shown a link to a 404. A tab the access
// table does not know (undefined) is offered. Each page guards itself; a layout gets no pathname.
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const tabs = TABS.filter((t) => adminRouteAllowed(t.href, me, tenant) !== false);
  if (tabs.length === 0) notFound();
  return (
    <div className="admin-shell--full">
      <SectionTabs tabs={tabs} />
      {children}
    </div>
  );
}
