"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Icon } from "./icons";

// Global "＋ New" affordance in the top bar. Items are computed server-side
// (RBAC-gated) and passed in; this only handles the open/close menu.
export function NewMenu({ items }: { items: { label: string; href: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="erp-new" ref={ref}>
      <button type="button" className="erp-new__btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={16} /> New
      </button>
      {open && (
        <div className="erp-new__menu" role="menu">
          {items.map((it) => (
            <Link key={it.href} href={it.href} role="menuitem" className="erp-new__item" onClick={() => setOpen(false)}>
              {it.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
