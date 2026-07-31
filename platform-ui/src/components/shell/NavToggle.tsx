"use client";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";

// Mobile navigation control. Below the drawer breakpoint the sidebar leaves the
// grid and becomes an off-canvas panel; this button is the only way back to it.
//
// The open flag lives on <html> as data-nav rather than in a context, because
// the button sits in TopBar while the panel it controls is Sidebar — two
// siblings under the shell grid. An attribute on the root lets CSS reach both
// without lifting state into Shell and turning the whole shell into a client
// component (Sidebar and TopBar are async server components that fetch).
export function NavToggle() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const root = document.documentElement;
    if (open) root.setAttribute("data-nav", "open");
    else root.removeAttribute("data-nav");
    return () => root.removeAttribute("data-nav");
  }, [open]);

  // Tapping a nav link navigates; the panel should not stay over the page it
  // just took you to.
  useEffect(close, [pathname, close]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Move focus into the panel on open and hand it back to the button on close,
  // so the drawer is operable from the keyboard. This is focus *placement*, not
  // a full focus trap — tabbing past the last link walks into the page behind.
  useEffect(() => {
    if (!open) return;
    const first = document.querySelector<HTMLElement>(".erp-side a, .erp-side button");
    first?.focus();
    return () => document.querySelector<HTMLElement>(".erp-navtoggle")?.focus();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="erp-navtoggle"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="app-nav"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? "x" : "menu"} size={22} />
      </button>
      {open && (
        <button type="button" className="erp-scrim" aria-label="Close navigation" tabIndex={-1} onClick={close} />
      )}
    </>
  );
}
