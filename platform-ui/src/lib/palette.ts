// Command palette (Cmd/Ctrl-K) data model — UI redesign §4. Pure, client-safe: builds tier-1
// (static nav) and tier-2 (department toolkit) destinations from data the shell ALREADY computes
// server-side and is already RBAC-filtered by construction (`navFor()` takes `me`/`tenantId`;
// `toolkitFor()` is a pure lookup with no capability surface of its own). No network cost — Shell.tsx
// builds this list in the same request that renders the sidebar and hands it to the client
// CommandPalette component as a plain, serialisable array.
//
// Tier 3 (live records) is NOT built here — it is a genuine per-keystroke network read, so it goes
// through `/api/search/palette` (the single-egress route handler) straight from CommandPalette.tsx.
import type { NavGroup } from "@/components/shell/nav";
import type { IconName } from "@/components/shell/icons";
import { toolkitFor, deptTabs, tabHref } from "./deptToolkits";

export interface PaletteEntry {
  id: string;
  label: string;
  href: string;
  /** Groups results in the palette list — the nav group label, or "Departments" for tier 2. */
  section: string;
  icon: IconName;
}

/** Tier 1 — every NavItem from navFor(), flattened. Already RBAC-filtered (navFor's own job). */
export function buildNavEntries(groups: NavGroup[]): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      out.push({ id: `nav:${item.href}`, label: item.label, href: item.href, section: g.label || "Navigate", icon: item.icon });
    }
  }
  return out;
}

/** Tier 2 — every DeptTab across every department the active company has, via the same
 *  `toolkitFor()`/`tabHref()` DeptTabs.tsx itself uses. The department's OWN root ("Home", `path:
 *  ""`) is skipped — navFor() already lists it once as the department's row in the Departments
 *  group, so this only adds what nav does NOT already surface (Board, Timeline, Connections, …). */
export function buildDeptEntries(departments: { id: string; name: string }[]): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const d of departments) {
    const toolkit = toolkitFor(d.name);
    for (const tab of deptTabs(toolkit)) {
      if (tab.path === "") continue;
      out.push({ id: `dept:${d.id}:${tab.key}`, label: `${d.name} · ${tab.label}`, href: tabHref(d.id, tab), section: "Departments", icon: tab.icon });
    }
  }
  return out;
}
