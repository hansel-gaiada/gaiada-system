"use client";
import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import type { NavItem } from "./nav";

// An expandable nav item: a parent link plus a chevron that reveals its children
// (e.g. Departments → one child per department, each opening that department's
// console). Auto-expands when the parent or any child route is active; the user
// can still toggle it manually. A child is "active" for the whole console subtree
// (…/departments/x AND …/departments/x/workflow) so the department stays lit.
export function NavDisclosure({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const children = item.children ?? [];
  const isChildActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const parentActive = pathname === item.href;
  const autoOpen = parentActive || children.some((c) => isChildActive(c.href));
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? autoOpen;

  return (
    <div className="erp-disc">
      <div className="erp-disc__head">
        <Link
          href={item.href}
          className={`erp-navbtn${parentActive ? " erp-navbtn--active" : ""}`}
          style={{ flex: 1 }}
          aria-current={parentActive ? "page" : undefined}
        >
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </Link>
        {children.length > 0 && (
          <button
            type="button"
            className="erp-disc__toggle"
            aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
            aria-expanded={open}
            onClick={() => setManual(!open)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s var(--erp-ease)" }} aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        )}
      </div>
      {open && children.length > 0 && (
        <div className="erp-disc__kids">
          {children.map((c) => {
            const active = isChildActive(c.href);
            return (
              <Link key={c.href} href={c.href} className={`erp-navbtn erp-navbtn--sub${active ? " erp-navbtn--active" : ""}`} aria-current={active ? "page" : undefined}>
                <span className="erp-disc__bullet" aria-hidden="true" />
                <span>{c.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
