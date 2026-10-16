// Command palette (Cmd/Ctrl-K) data model — UI redesign §4, rebuilt on the workspace shell's registry (DW-2e, DW-9d).
// Pure, client-safe: tier 1 is every concrete tab of the person's shell model (`buildWorkspaceEntries`) plus a small,
// explicit, GATED list of pages the sidebar does not draw (`STATIC_PALETTE_ENTRIES`); both come from data the shell
// ALREADY computes server-side and is RBAC-filtered by construction. No network cost — Shell.tsx builds this list in the
// same request that renders the sidebar and hands it to the client CommandPalette component as a plain, serialisable array.
//
// Tier 3 (live records) is NOT built here — it is a genuine per-keystroke network read, so it goes
// through `/api/search/palette` (the single-egress route handler) straight from CommandPalette.tsx.
import type { Me } from "@/lib/platform";
import type { IconName } from "@/components/shell/icons";
import type { Gate } from "./workspaces";
import { gateAllows, type ConcreteRow } from "./workspaceAccess";
import type { ShellModel } from "./shellModel";

export interface PaletteEntry {
  id: string;
  label: string;
  href: string;
  /** Groups results in the palette list — the workspace name, "You", "Performance", "Company", "Admin", or a static entry's own. */
  section: string;
  icon: IconName;
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

/** A page the palette offers that the sidebar does not draw, with the gate its old nav row carried (DW-9d). */
interface StaticPaletteEntry { href: string; label: string; section: string; icon: IconName; gate?: Gate }

/** Pages findable before the classic nav retired (DW-9d, plan §13 trap 1) that no tab of a person's shell model carries, so
 *  retiring `navFor` must not drop them. Measured per persona against the real functions before the removal, over every role of
 *  `Role` x agency/hospitality/holding companies x placed/unplaced x global/company/unit scope: exactly these pages.
 *  Every gate is the one its nav row had (an absent gate = the row was ungated), never a simplification of it. The shell is
 *  staff-only (`(app)/layout.tsx` sends a client-only person to the portal), so "ungated" means "every staff person".
 *  - Approvals: the sidebar's row hides from a member with nothing waiting and no right to decide (DW-D23); the PAGE stays
 *    reachable for everyone and the server decides who may act.
 *  - Project and Department Reports: the registry offers the department grain only to a head (`unitCap`), the old nav row was
 *    ungated and the page renders the server's own refusal.
 *  - Learning overview and, for the holders of the company-wide right, Authoring and Compliance: the registry offers those
 *    two only per department (`?unit=`), so a company-wide holder with no department node had no other way in.
 *  `/` ("Dashboard") is deliberately not here: it only redirects to the home workspace's Overview or the Company area, both of
 *  which are entries already. */
export const STATIC_PALETTE_ENTRIES: readonly StaticPaletteEntry[] = [
  { href: "/approvals", label: "Approvals", section: "You", icon: "check" },
  { href: "/reports/project", label: "Project Reports", section: "Reports", icon: "pulse" },
  { href: "/reports/department", label: "Department Reports", section: "Reports", icon: "pulse" },
  { href: "/learning", label: "Learning overview", section: "Learning", icon: "home" },
  { href: "/learning/authoring", label: "Learning authoring", section: "Learning", icon: "projects", gate: { kind: "cap", cap: "lms.authoring" } },
  { href: "/learning/compliance", label: "Learning compliance", section: "Learning", icon: "check", gate: { kind: "cap", cap: "lms.progress.view" } },
];

/** The static entries this person may be offered (each gate evaluated against the active company, as the nav row was). */
export function staticPaletteEntries(me: Me, tenantId: string | null): PaletteEntry[] {
  return STATIC_PALETTE_ENTRIES
    .filter((e) => gateAllows(e.gate, { me, tenantId, unitPath: [] }))
    .map((e) => ({ id: `static:${e.href}`, label: e.label, href: e.href, section: e.section, icon: e.icon }));
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

/** What the shell hands the palette: the model's own entries, then the explicit static ones (the model's entry wins a clash). */
export function workspacePaletteEntries(model: ShellModel, me: Me, tenantId: string | null): PaletteEntry[] {
  return mergePaletteEntries(buildWorkspaceEntries(model), staticPaletteEntries(me, tenantId));
}
