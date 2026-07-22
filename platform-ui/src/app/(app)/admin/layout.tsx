import { SectionTabs } from "@/components/shell/SectionTabs";

// Settings (formerly "Admin"). Its sub-sections are in-page tabs here rather than
// separate sidebar entries; each page renders its own header + content below.
const TABS = [
  { key: "users", label: "Users & Roles", href: "/admin/users", icon: "hr" as const },
  { key: "identity", label: "Identity Links", href: "/admin/identity", icon: "hub" as const },
  { key: "modules", label: "Modules & Fields", href: "/admin/modules", icon: "box" as const },
  { key: "compliance", label: "Compliance", href: "/admin/compliance", icon: "check" as const },
  { key: "audit", label: "Audit", href: "/admin/audit", icon: "clock" as const },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SectionTabs tabs={TABS} />
      {children}
    </>
  );
}
