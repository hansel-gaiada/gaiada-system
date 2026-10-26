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
export function NewMenu({ items, row }: { items: { label: string; href: string }[]; row?: { label: string; icon: IconName } }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
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
      className={`erp-new__menu${row ? " erp-new__menu--pin" : ""}`}
      role="menu"
      {...(row && at ? { style: { "--pin-menu-top": `${at.top}px`, "--pin-menu-left": `${at.left}px` } as CSSProperties } : {})}
    >
      {items.map((it) => (
        <Link key={it.href} href={it.href} role="menuitem" className="erp-new__item" onClick={() => setOpen(false)}>
          {it.label}
        </Link>
      ))}
    </div>
  );

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
            setAt({ top: r.top, left: r.right + 8 });
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
