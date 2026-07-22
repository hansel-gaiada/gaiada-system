"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icons";

export interface SectionTab { key: string; label: string; href: string; icon: IconName }

// A generic in-page tab strip used by every console-style section (department
// workspaces, IT, HR, Settings). Active tab = the one whose href is the deepest
// prefix of the current path, so a sub-route (…/devices/abc) still lights its
// parent tab (Devices). Pure client component — resolves active from pathname.
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const pathname = usePathname();
  let active: SectionTab | null = null;
  for (const t of tabs) {
    const match = pathname === t.href || pathname.startsWith(`${t.href}/`);
    if (match && (!active || t.href.length > active.href.length)) active = t;
  }
  return (
    <nav className="sec-tabs" aria-label="Section">
      {tabs.map((t) => {
        const isActive = active?.key === t.key;
        return (
          <Link key={t.key} href={t.href} className={`sec-tab${isActive ? " sec-tab--active" : ""}`} aria-current={isActive ? "page" : undefined}>
            <Icon name={t.icon} size={16} />
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
