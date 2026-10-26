"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { logout } from "@/app/(app)/account/actions";
import type { Theme } from "@/lib/prefs";
import { ThemeToggle } from "./ThemeToggle";
import { setSkinChoiceAction } from "@/lib/prefsActions";
import { SKINS } from "@/lib/skins";
import { useWorkspaceShell } from "./WorkspaceShellContext";

// The sidebar user-card, upgraded to a menu button: opens a small popover with
// "Account settings" and "Sign out". Closes on outside-click or Escape.
// `compact` is the TOP-BAR placement the design uses: avatar + chevron only,
// with the popover opening DOWNWARD. The default (sidebar floor) opens upward
// and shows name + role. Same component, same menu items, same actions.
// `clientView` (PV2-06) adds a "Client view" link to /portal for staff who are also client contacts.
// `theme` (DW-2c) puts the Theme control (the same ThemeToggle, same cookie) first in the menu; the
// workspace top bar has no separate theme button. Without it the menu is exactly as it was.
// SCP-Kd (DW-D51): a person who chose the Standard look on a workspace that has a skin on is offered the way back here, "Use the Social look".
// Nothing else changes: where no skin is on, or outside the workspace shell, the menu is exactly as it was.
export function UserMenu({ name, secondary, initials, compact = false, clientView = false, theme }: {
  name: string; secondary: string; initials: string; compact?: boolean; clientView?: boolean; theme?: Theme;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shell = useWorkspaceShell();
  const ws = shell?.view.kind === "workspace" ? shell.view.ws : null;
  // A skin is on for this workspace (`skinOffered`) yet it is drawn Standard: the person's own choice.
  const skinBack = ws && ws.skinOffered && ws.skin === "standard" ? ws.skinOffered : null;

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
              <ThemeToggle theme={theme} inMenu />
            </div>
          )}
          {skinBack && <SkinBackItem skin={skinBack} onDone={() => setOpen(false)} />}
          <Link href="/account" role="menuitem" className="erp-usermenu__item" onClick={() => setOpen(false)}>
            Account settings
          </Link>
          {clientView && (
            <Link href="/portal" role="menuitem" className="erp-usermenu__item" onClick={() => setOpen(false)}>
              Client view
            </Link>
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

/** "Use the <skin> look": sets the person's choice back to the workspace's own skin and has the layout rebuild the shell model. Its own component so
 *  the router is read only where the item is drawn. */
function SkinBackItem({ skin, onDone }: { skin: keyof typeof SKINS; onDone: () => void }) {
  const router = useRouter();
  return (
    <button
      type="button"
      role="menuitem"
      className="erp-usermenu__item"
      onClick={() => {
        onDone();
        void setSkinChoiceAction("workspace").then(() => router.refresh());
      }}
    >
      Use the {SKINS[skin].label} look
    </button>
  );
}
