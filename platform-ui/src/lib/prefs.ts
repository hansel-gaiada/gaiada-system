import "server-only";
// Per-user display preferences, persisted in a cookie (no backend needed).
// Applied as data-attributes on the app shell so pure CSS does the rest.
import { cookies } from "next/headers";

export type Density = "comfortable" | "compact";
export type Width = "standard" | "wide";
/** "auto" follows prefers-color-scheme; the other two pin the theme. */
export type Theme = "auto" | "light" | "dark";

export interface Prefs {
  density: Density;
  width: Width;
  theme: Theme;
  /** The `/assistant` workspace's left rail (ThreadRail), collapsed to a narrow icon strip or the
   *  full session list — the one per-surface flag in this cookie, following the SAME "persist in
   *  gaiada_prefs, don't invent a new store" convention density/width/theme already set (see
   *  AssistantWorkspace + lib/prefsActions.ts). */
  assistantRailCollapsed: boolean;
}

// Width defaults to "wide" (no max-width): the suite is dominated by tables, boards and console
// grids, which the 1180px reading measure squeezed into needless horizontal scrolling on a normal
// desktop. "standard" stays available in Account -> Content width for anyone who prefers the
// narrower measure for the prose-shaped pages.
export const DEFAULT_PREFS: Prefs = { density: "comfortable", width: "wide", theme: "auto", assistantRailCollapsed: false };
const COOKIE = "gaiada_prefs";

const DENSITIES: Density[] = ["comfortable", "compact"];
const WIDTHS: Width[] = ["standard", "wide"];
const THEMES: Theme[] = ["auto", "light", "dark"];

export async function getPrefs(): Promise<Prefs> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return DEFAULT_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      density: DENSITIES.includes(parsed.density as Density) ? (parsed.density as Density) : DEFAULT_PREFS.density,
      width: WIDTHS.includes(parsed.width as Width) ? (parsed.width as Width) : DEFAULT_PREFS.width,
      theme: THEMES.includes(parsed.theme as Theme) ? (parsed.theme as Theme) : DEFAULT_PREFS.theme,
      assistantRailCollapsed: typeof parsed.assistantRailCollapsed === "boolean"
        ? parsed.assistantRailCollapsed
        : DEFAULT_PREFS.assistantRailCollapsed,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export type SidebarState = "expanded" | "collapsed";
export const SIDEBAR_COOKIE = "gaiada_sidebar";

// Separate cookie from the prefs blob: the toggle writes it client-side for an
// instant collapse, so it must not have to round-trip (or clobber) the rest.
export async function getSidebarState(): Promise<SidebarState> {
  const jar = await cookies();
  return jar.get(SIDEBAR_COOKIE)?.value === "collapsed" ? "collapsed" : "expanded";
}

export async function writePrefs(next: Prefs): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, JSON.stringify(next), {
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  });
}
