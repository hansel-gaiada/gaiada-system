"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { logout } from "@/app/(app)/account/actions";
import { ThemeSwitch } from "./ThemeSwitch";
import type { Theme } from "@/lib/prefs";

// The sidebar user-card, upgraded to a menu button: opens a small popover with
// "Account settings" and "Sign out". Closes on outside-click or Escape.
export function UserMenu({ name, secondary, initials, theme }: { name: string; secondary: string; initials: string; theme: Theme }) {
  const [open, setOpen] = useState(false);
  // The panel animates IN and then vanished on a frame, which is half a gesture: the eye is told
  // the menu was pulled out of the card and then that it was deleted. `closing` keeps it mounted
  // for the reverse, and the element itself tells us when to unmount (`onAnimationEnd`) rather than
  // a timeout guessing at the CSS duration — under `prefers-reduced-motion` the duration collapses
  // to ~0 and the event still fires, so the panel simply disappears as that reader asked.
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  function close() {
    setOpen((wasOpen) => { if (wasOpen) setClosing(true); return wasOpen; });
  }
  function toggle() {
    // Clicking the trigger DURING the close catches it and reopens, rather than re-closing an
    // already-closing panel and making the reader click twice.
    if (closing) { setClosing(false); setOpen(true); return; }
    if (open) close();
    else { setClosing(false); setOpen(true); }
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
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
        <div
          className={`erp-usermenu__pop${closing ? " erp-usermenu__pop--closing" : ""}`}
          role="menu"
          aria-label="Account menu"
          // While it is on its way out it is a picture, not a control: no clicks, and nothing for a
          // screen reader to walk into.
          aria-hidden={closing || undefined}
          onAnimationEnd={() => { if (closing) { setClosing(false); setOpen(false); } }}
        >
          <Link href="/account" role="menuitem" className="erp-usermenu__item" onClick={close}>
            Account settings
          </Link>
          <form action={logout}>
            <button type="submit" role="menuitem" className="erp-usermenu__item erp-usermenu__item--danger">
              Sign out
            </button>
          </form>
          {/* Below the destructive item on purpose: a preference is not a place you land by
              accident on the way to signing out, and it is the one control here you might use
              twice in a day. */}
          <ThemeSwitch current={theme} />
        </div>
      )}
      <button
        type="button"
        className="erp-side__user erp-usermenu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <div className="erp-side__avatar">{initials}</div>
        <div style={{ minWidth: 0, lineHeight: 1.25, textAlign: "left" }}>
          <div style={{ font: "700 13px var(--font-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
          <div style={{ font: "400 11px var(--font-body)", color: "var(--ink-subtle)" }}>{secondary}</div>
        </div>
      </button>
    </div>
  );
}
