"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { useRailTooltip } from "./railTooltip";
import type { NavItem } from "./nav";

// App Router layouts/server components can't know the active child route — usePathname()
// only works client-side. This tiny client component owns just the active-state comparison
// so Sidebar/Shell/the (app) layout can stay server components.
export function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const active = pathname === item.href;
  const { tip, triggerProps } = useRailTooltip(item.label);
  return (
    <>
      <Link
        href={item.href}
        className={`erp-navbtn${active ? " erp-navbtn--active" : ""}`}
        aria-label={item.label}
        aria-current={active ? "page" : undefined}
        {...triggerProps}
      >
        <Icon name={item.icon} />
        <span>{item.label}</span>
      </Link>
      {tip}
    </>
  );
}
