"use client";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { NavLink } from "./NavLink";
import { RailCategory } from "./RailCategory";
import { useSidebarState } from "./sidebarState";
import { type NavGroup } from "./nav";

// One collapsible unit per group, so ~35 destinations don't all compete at once.
// Multi-open on purpose (ERP work spans two groups), the group holding the
// current route opens by default, and an explicit toggle wins over that default.
export function NavGroupSection({ group }: { group: NavGroup }) {
  const pathname = usePathname();
  const { rail } = useSidebarState();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? (group.pinned || group.items.some((i) => i.href === pathname));
  const id = `nav-${group.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  // In the rail, a flyout for one row (or for a pinned group) costs more than it saves.
  if (rail) {
    if (group.pinned || group.items.length === 1) {
      return (
        <div className="erp-navgroup erp-navgroup--open">
          <div className="erp-navgroup__items">
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
          </div>
        </div>
      );
    }
    return <RailCategory group={group} />;
  }

  return (
    <div className={`erp-navgroup${open ? " erp-navgroup--open" : ""}`}>
      <button
        type="button"
        className="erp-navgroup__head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOverride(!open)}
      >
        {/* The group carries the glyph in the design; children are plain text.
            `?? "box"` mirrors the rail's own documented fallback for a group
            that never declared one (Workspace is pinned and has none). */}
        <span className="erp-navgroup__icon" aria-hidden="true">
          <Icon name={group.icon ?? "box"} size={17} />
        </span>
        <span className="erp-side__grouplabel">{group.label}</span>
        <span className="erp-navgroup__chev">
          <Icon name="chevron" size={14} />
        </span>
      </button>
      <div className="erp-navgroup__items" id={id}>
        {group.items.map((item) => (
          <NavLink key={item.href} item={item} />
        ))}
      </div>
    </div>
  );
}
