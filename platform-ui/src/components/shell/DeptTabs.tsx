"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { type DeptGroup, tabHref } from "@/lib/deptToolkits";

// Two-level department-console navigation (2026-07-23 IA redesign). Renders a
// PRIMARY strip of groups plus, when the active group has more than one tab, a
// subordinate SECONDARY strip of that group's tabs. Active resolution mirrors
// SectionTabs: the active tab is the one whose href is the deepest prefix of the
// current path (so `…/board/abc` still lights Board → Work), and the active
// group is whichever group owns that tab. Pure client component — all pathname
// logic lives here so the server layout only passes serialisable data.
export function DeptTabs({ groups, deptId }: { groups: DeptGroup[]; deptId: string }) {
  const pathname = usePathname();

  let active: { groupKey: string; href: string; len: number } | null = null;
  for (const g of groups) {
    for (const t of g.tabs) {
      const href = tabHref(deptId, t);
      const match = pathname === href || pathname.startsWith(`${href}/`);
      if (match && (!active || href.length > active.len)) active = { groupKey: g.key, href, len: href.length };
    }
  }
  const activeGroup = groups.find((g) => g.key === active?.groupKey) ?? groups[0] ?? null;

  return (
    <>
      <nav className="sec-tabs" aria-label="Department sections">
        {groups.map((g) => {
          const isActive = activeGroup?.key === g.key;
          return (
            <Link
              key={g.key}
              href={tabHref(deptId, g.tabs[0])}
              className={`sec-tab${isActive ? " sec-tab--active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon name={g.icon} size={16} />
              <span>{g.label}</span>
            </Link>
          );
        })}
      </nav>
      {activeGroup && activeGroup.tabs.length > 1 && (
        <nav className="sub-tabs" aria-label={`${activeGroup.label} tools`}>
          {activeGroup.tabs.map((t) => {
            const href = tabHref(deptId, t);
            const isActive = active?.href === href;
            return (
              <Link
                key={t.key}
                href={href}
                className={`sub-tab${isActive ? " sub-tab--active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon name={t.icon} size={14} />
                <span>{t.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </>
  );
}
