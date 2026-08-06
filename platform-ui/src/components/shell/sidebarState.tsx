"use client";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

// Mirrors SIDEBAR_COOKIE in lib/prefs.ts, which is server-only.
const COOKIE = "gaiada_sidebar";
const RAIL = "(min-width: 761px)";

const Ctx = createContext<{ collapsed: boolean; rail: boolean; toggle: () => void }>({ collapsed: false, rail: false, toggle: () => {} });

export function useSidebarState() {
  return useContext(Ctx);
}

// Shared because the rail is a different renderer, not just narrower CSS: groups
// become flyout categories, so React itself has to know the mode.
export function SidebarState({ initial, children }: { initial: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initial);
  // Below the rail breakpoint the sidebar is an off-canvas drawer with labels, so
  // a collapsed cookie must not turn it into icons there.
  const [wide, setWide] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia(RAIL);
    setWide(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    // The <html> flag drives the grid column width; the cookie survives reloads.
    const root = document.documentElement;
    if (next) root.setAttribute("data-sidebar", "collapsed");
    else root.removeAttribute("data-sidebar");
    const secure = location.protocol === "https:" ? ";secure" : "";
    document.cookie = `${COOKIE}=${next ? "collapsed" : "expanded"};path=/;max-age=31536000;samesite=lax${secure}`;
  }

  return <Ctx.Provider value={{ collapsed, rail: collapsed && wide, toggle }}>{children}</Ctx.Provider>;
}
