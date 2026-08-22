"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import "./Tabs.css";

export interface TabItem {
  key: string;
  label: string;
  href: string;
  icon?: ReactNode;
}

// Active tab = the one whose href is the deepest prefix of the current path, so a sub-route
// (e.g. …/devices/abc) still lights its parent tab (Devices). Same resolution `SectionTabs`/
// `DeptTabs` (components/shell/) already use — pulled out here as the shared, dependency-free
// primitive so a fifth console doesn't grow a fifth copy (§6, "Tabs — EXTEND/unify"). Those two
// shell files are frozen through Phase 2/3 and are NOT migrated onto this by this pass; this is
// the target for new consumers and a future consolidation pass.
function resolveActive(pathname: string, tabs: TabItem[]): TabItem | null {
  let active: TabItem | null = null;
  for (const t of tabs) {
    const match = pathname === t.href || pathname.startsWith(`${t.href}/`);
    if (match && (!active || t.href.length > active.href.length)) active = t;
  }
  return active;
}

export function Tabs({ tabs, label = "Section" }: { tabs: TabItem[]; label?: string }) {
  const pathname = usePathname();
  const active = resolveActive(pathname, tabs);
  return (
    <nav className="ui-tabs" aria-label={label}>
      {tabs.map((t) => {
        const isActive = active?.key === t.key;
        return (
          <Link key={t.key} href={t.href} className={`ui-tab${isActive ? " ui-tab--active" : ""}`} aria-current={isActive ? "page" : undefined}>
            {t.icon}
            <span>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export interface TabGroup {
  key: string;
  label: string;
  icon?: ReactNode;
  tabs: TabItem[];
}

// Two-level variant for a `DeptTabs`-shaped case: a primary group strip plus, when the active
// group carries more than one tab, a subordinate secondary strip — a group with exactly one tab
// collapses to a direct link with no redundant one-item sub-strip, same rule DeptTabs already
// uses.
export function GroupedTabs({
  groups,
  groupLabel = "Sections",
  subLabel = "Tools",
}: {
  groups: TabGroup[];
  groupLabel?: string;
  subLabel?: string;
}) {
  const pathname = usePathname();
  let activeGroupKey: string | null = null;
  let bestLen = -1;
  for (const g of groups) {
    const hit = resolveActive(pathname, g.tabs);
    if (hit && hit.href.length > bestLen) {
      bestLen = hit.href.length;
      activeGroupKey = g.key;
    }
  }
  const activeGroup = groups.find((g) => g.key === activeGroupKey) ?? groups[0] ?? null;
  const activeSub = activeGroup ? resolveActive(pathname, activeGroup.tabs) : null;

  return (
    <>
      <nav className="ui-tabs" aria-label={groupLabel}>
        {groups.map((g) => {
          const isActive = activeGroup?.key === g.key;
          return (
            <Link
              key={g.key}
              href={g.tabs[0]?.href ?? "#"}
              className={`ui-tab${isActive ? " ui-tab--active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              {g.icon}
              <span>{g.label}</span>
            </Link>
          );
        })}
      </nav>
      {activeGroup && activeGroup.tabs.length > 1 && (
        <nav className="ui-subtabs" aria-label={`${activeGroup.label} ${subLabel}`}>
          {activeGroup.tabs.map((t) => {
            const isActive = activeSub?.key === t.key;
            return (
              <Link key={t.key} href={t.href} className={`ui-subtab${isActive ? " ui-subtab--active" : ""}`} aria-current={isActive ? "page" : undefined}>
                {t.icon}
                <span>{t.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </>
  );
}
