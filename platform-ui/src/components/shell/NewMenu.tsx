"use client";
import { useState, useRef, useEffect, type CSSProperties } from "react";
import Link from "next/link";
import { Icon, type IconName } from "./icons";
import { useRailTooltip } from "./railTooltip";

// Global "＋ New" affordance in the top bar. Items are computed server-side
// (RBAC-gated) and passed in; this only handles the open/close menu.
//
// SCP-Kc: `row` draws the trigger as a menu row (the Social skin's "Create") instead of the gold button. It is the same menu with the same
// items. The sidebar's nav column scrolls, which would clip an absolutely placed menu, so in row mode the menu is placed by the trigger's
// rectangle (CSS reads `--pin-menu-top` and `--pin-menu-left`) and Escape closes it.
export function NewMenu({ items, row }: { items: { label: string; href: string }[]; row?: { label: string; icon: IconName; bar?: boolean } }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number; bottom: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { tip, triggerProps } = useRailTooltip(row?.label ?? "New");
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (row && e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open, row]);

  if (items.length === 0) return null;

  const menu = open && (
    <div
      className={`erp-new__menu${row ? (row.bar ? " erp-new__menu--bar" : " erp-new__menu--pin") : ""}`}
      role="menu"
      {...(row && at ? { style: { "--pin-menu-top": `${at.top}px`, "--pin-menu-left": `${at.left}px`, "--pin-menu-bottom": `${at.bottom}px` } as CSSProperties } : {})}
    >
      {items.map((it) => (
        <Link key={it.href} href={it.href} role="menuitem" className="erp-new__item" onClick={() => setOpen(false)}>
          {it.label}
        </Link>
      ))}
    </div>
  );

  if (row?.bar) {
    // The phone's bottom bar (SCP-Ke): an icon-only button, its menu opening upward from it.
    return (
      <div className="erp-new erp-new--bar" ref={ref}>
        <button
          type="button"
          className="ws-bar__btn"
          aria-label={row.label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAt({ top: r.top, left: r.left, bottom: window.innerHeight - r.top + 8 });
            setOpen((o) => !o);
          }}
        >
          <Icon name={row.icon} size={24} stroke={2} />
        </button>
        {menu}
      </div>
    );
  }

  if (row) {
    return (
      <div className="erp-new erp-new--pin" ref={ref}>
        <button
          type="button"
          className="erp-navbtn ws-row ws-pin"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAt({ top: r.top, left: r.right + 8, bottom: 0 });
            setOpen((o) => !o);
          }}
          {...triggerProps}
        >
          <Icon name={row.icon} size={24} stroke={2} />
          <span>{row.label}</span>
        </button>
        {tip}
        {menu}
      </div>
    );
  }

  return (
    <div className="erp-new" ref={ref}>
      <button type="button" className="erp-new__btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={16} /> New
      </button>
      {menu}
    </div>
  );
}

/** The New menu's items: the workspace's own create actions first, then the shell's, a later item with the same href dropped (DW-2f). The
 *  sidebar and the phone's bottom bar (SCP-Ke) both open the menu with exactly these. */
export function menuItemsFor(creates: readonly { label: string; href: string }[], newItems: readonly { label: string; href: string }[]): { label: string; href: string }[] {
  return [...creates, ...newItems.filter((it) => !creates.some((c) => c.href === it.href))];
}
