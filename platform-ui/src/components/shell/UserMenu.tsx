"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { logout } from "@/app/(app)/account/actions";
import { setShellLayoutAction } from "@/lib/prefsActions";
import type { ShellLayout } from "@/lib/shellLayout";
import type { Theme } from "@/lib/prefs";
import { ThemeToggle } from "./ThemeToggle";

// The sidebar user-card, upgraded to a menu button: opens a small popover with
// "Account settings" and "Sign out". Closes on outside-click or Escape.
// `compact` is the TOP-BAR placement the design uses: avatar + chevron only,
// with the popover opening DOWNWARD. The default (sidebar floor) opens upward
// and shows name + role. Same component, same menu items, same actions.
// `clientView` (PV2-06) adds a "Client view" link to /portal for staff who are also client contacts.
// `shellLayout` (DW-2a) adds the pilot switch between the classic shell and the workspace shell; the
// action stores the choice and revalidates the layout, so the next render draws the other sidebar.
// `theme` (DW-2c) puts the Theme control (the same ThemeToggle, same cookie) first in the menu; the
// workspace top bar has no separate theme button. Without it the menu is exactly as it was.
export function UserMenu({ name, secondary, initials, compact = false, clientView = false, shellLayout, theme }: {
  name: string; secondary: string; initials: string; compact?: boolean; clientView?: boolean; shellLayout?: ShellLayout; theme?: Theme;
}) {
  const [open, setOpen] = useState(false);
  const [switching, startSwitch] = useTransition();
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
    <div className={`erp-usermenu${compact ? " erp-usermenu--top" : ""}${theme ? " erp-usermenu--theme" : ""}`} ref={ref}>
      {open && (
        <div className="erp-usermenu__pop" role="menu" aria-label="Account menu">
          {theme && (
            <div className="erp-usermenu__theme" role="group" aria-label="Theme">
              <span className="erp-usermenu__theme-label" aria-hidden="true">Theme</span>
              <ThemeToggle theme={theme} />
            </div>
          )}
          <Link href="/account" role="menuitem" className="erp-usermenu__item" onClick={() => setOpen(false)}>
            Account settings
          </Link>
          {clientView && (
            <Link href="/portal" role="menuitem" className="erp-usermenu__item" onClick={() => setOpen(false)}>
              Client view
            </Link>
          )}
          {shellLayout && (
            <button
              type="button"
              role="menuitem"
              className="erp-usermenu__item"
              disabled={switching}
              onClick={() => {
                const next: ShellLayout = shellLayout === "classic" ? "workspaces" : "classic";
                startSwitch(async () => {
                  await setShellLayoutAction(next);
                  setOpen(false);
                });
              }}
            >
              {shellLayout === "classic" ? "Try the new layout" : "Back to the classic layout"}
            </button>
          )}
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
        // Compact (top bar) shows the avatar only, so the name is hidden from the accessibility tree
        // by CSS and the button would be announced as just the initials.
        aria-label={compact ? name : undefined}
        onClick={() => setOpen((v) => !v)}
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
