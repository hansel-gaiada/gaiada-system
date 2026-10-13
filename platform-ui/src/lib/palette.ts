// Command palette (Cmd/Ctrl-K) data model — UI redesign §4. Pure, client-safe: builds tier-1
// (static nav) and tier-2 (department toolkit) destinations from data the shell ALREADY computes
// server-side and is already RBAC-filtered by construction (`navFor()` takes `me`/`tenantId`;
// `toolkitFor()` is a pure lookup keyed by the company's vertical, with no capability surface of its own). No network cost — Shell.tsx
// builds this list in the same request that renders the sidebar and hands it to the client
// CommandPalette component as a plain, serialisable array.
//
// Tier 3 (live records) is NOT built here — it is a genuine per-keystroke network read, so it goes
// through `/api/search/palette` (the single-egress route handler) straight from CommandPalette.tsx.
import type { NavGroup } from "@/components/shell/nav";
import type { IconName } from "@/components/shell/icons";
import { toolkitFor, deptTabs, tabHref, type DeptTab } from "./deptToolkits";
import type { ConcreteRow } from "./workspaceAccess";
import type { ShellModel } from "./shellModel";

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
export function buildDeptEntries(
  departments: { id: string; name: string }[], vertical: string | null | undefined,
  /** M5-V3-i: false hides a tab the viewer may not open (a tab with `requires`); absent = every tab is offered. */
  allow: (tab: DeptTab) => boolean = () => true,
): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const d of departments) {
    const toolkit = toolkitFor(vertical, d.name);
    for (const tab of deptTabs(toolkit)) {
      if (tab.path === "" || !allow(tab)) continue;
      out.push({ id: `dept:${d.id}:${tab.key}`, label: `${d.name} · ${tab.label}`, href: tabHref(d.id, tab), section: "Departments", icon: tab.icon });
    }
  }
  return out;
}

/** The text for one tab of a row: the row's own label once when its only tab carries it, else the tab's. */
function tabText(row: ConcreteRow, tab: ConcreteRow["tabs"][number]): string {
  return tab.label === row.label ? row.label : tab.label;
}

/** Workspace shell (DW-2e, plan §2.6 rule 3) — every concrete tab of every workspace of the model, then the
 *  Company and Admin rows. The model is already gated and concrete, so nothing here re-checks access.
 *  Overview, AI Assistant, Performance and You are the same pages in every workspace: they are listed once,
 *  from the home workspace (the first when home is Company), labelled plainly. A department-specific tab of
 *  those blocks (a different href) is still offered, under its workspace's name. First href wins. */
export function buildWorkspaceEntries(model: ShellModel): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const seen = new Set<string>();
  const push = (href: string, label: string, section: string, icon: PaletteEntry["icon"]) => {
    if (seen.has(href)) return;
    seen.add(href);
    out.push({ id: `ws:${href}`, label, href, section, icon });
  };
  const plain = (rows: ConcreteRow[], section: string) => {
    for (const row of rows) for (const t of row.tabs) {
      push(t.href, t.label === row.label ? row.label : `${row.label} · ${t.label}`, section, t.icon);
    }
  };
  const sharedHome = model.workspaces.find((w) => w.home) ?? model.workspaces[0];
  const sharedSection = (key: "top" | "performance" | "you", ws: string) => (key === "top" ? ws : key === "you" ? "You" : "Performance");

  // The home workspace's shared blocks first, so they win their hrefs with the plain labels.
  if (sharedHome) {
    for (const key of ["top", "performance", "you"] as const) plain(sharedHome.rows[key], sharedSection(key, sharedHome.label));
  }
  for (const ws of model.workspaces) {
    for (const row of ws.rows.work) for (const t of row.tabs) push(t.href, `${ws.label} · ${tabText(row, t)}`, ws.label, t.icon);
    for (const key of ["top", "performance", "you"] as const) {
      for (const row of ws.rows[key]) for (const t of row.tabs) push(t.href, `${ws.label} · ${tabText(row, t)}`, sharedSection(key, ws.label), t.icon);
    }
  }
  plain(model.company, "Company");
  plain(model.admin, "Admin");
  return out;
}

/** Entries are unique by href; the first list wins a clash. */
export function mergePaletteEntries(...lists: PaletteEntry[][]): PaletteEntry[] {
  const seen = new Set<string>();
  const out: PaletteEntry[] = [];
  for (const list of lists) for (const e of list) {
    if (seen.has(e.href)) continue;
    seen.add(e.href);
    out.push(e);
  }
  return out;
}

/** What the workspace shell hands the palette: the registry's entries, then today's nav and department
 *  entries, so nothing findable before stops being findable until the classic nav retires (DW-9d). */
export function workspacePaletteEntries(model: ShellModel, today: PaletteEntry[]): PaletteEntry[] {
  return mergePaletteEntries(buildWorkspaceEntries(model), today);
}
