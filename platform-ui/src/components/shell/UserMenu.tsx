"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { logout } from "@/app/(app)/account/actions";

// The sidebar user-card, upgraded to a menu button: opens a small popover with
// "Account settings" and "Sign out". Closes on outside-click or Escape.
export function UserMenu({ name, secondary, initials }: { name: string; secondary: string; initials: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="erp-usermenu" ref={ref}>
      {open && (
        <div className="erp-usermenu__pop" role="menu" aria-label="Account menu">
          <Link href="/account" role="menuitem" className="erp-usermenu__item" onClick={() => setOpen(false)}>
            Account settings
          </Link>
          <form action={logout}>
            <button type="submit" role="menuitem" className="erp-usermenu__item erp-usermenu__item--danger">
              Sign out
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        className="erp-side__user erp-usermenu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="erp-side__avatar">{initials}</div>
        <div style={{ minWidth: 0, lineHeight: 1.25, textAlign: "left" }}>
          <div style={{ font: "700 13px var(--font-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
          <div style={{ font: "400 11px var(--font-body)", color: "rgba(26,25,22,.55)" }}>{secondary}</div>
        </div>
      </button>
    </div>
  );
}
