// Department skins (SCP-Ka; DW-D51, docs/plans/2026-10-15-social-content-pipeline.md §6.1).
//
// A skin is a variant of the ONE workspace shell (DW-D38): it may change the menu's shape and which rows are pinned (the rest sit under
// More), the colours and type in light and dark, and the workspace's home layout. It never changes which pages exist or their
// addresses, who may see or do what, the data, what the status colours mean, or the items every skin keeps (⌘K, notifications, the AI
// Assistant, More with the workspace switcher, the SIMULATED and access marks).
//
// The rule is kept by construction here: a pinned entry is either a row the person's model ALREADY offers (by key, resolved against the
// gated, concrete rows) or one of the shell's own items. It can name no href of its own, so a skin cannot add a page or skip a gate.
//
// The skin follows the workspace (`Workspace.skin` in the registry), so everyone sees a department the same way; a person may choose
// the Standard skin for themselves (`SkinChoice`, in the prefs cookie). A skin other than Standard is drawn only once it is switched
// on: `SKINS_ON` in code (Kg switches Social on), or `SHELL_SKIN_PREVIEW` on a dev or test box.
//
// Pure and client-safe, like the registry.
import type { IconName } from "@/components/shell/icons";
import type { ConcreteRow } from "@/lib/workspaceAccess";

export type SkinKey = "standard" | "social";
export const SKIN_KEYS: readonly SkinKey[] = ["standard", "social"];

/** A person's own choice (DW-D51): the workspace's skin, or always Standard. Light or dark, density and width are separate prefs. */
export type SkinChoice = "workspace" | "standard";
export const SKIN_CHOICES: readonly SkinChoice[] = ["workspace", "standard"];

/** The shell's own items a skin may pin. Each does what the Standard top bar's control does: the search field (⌘K), the bell, "+ New". */
export type ShellItem = "search" | "notifications" | "create";

/** One pinned menu entry. `row` names a row of the workspace's model, and `tab` one of its tabs (the first when omitted); the entry is
 *  dropped when the person is not offered that row or tab. `ticket` marks an entry whose page is not built yet: never rendered while set,
 *  as in the registry. */
export type PinnedItem =
  | { kind: "row"; key: string; row: string; tab?: string; label?: string; icon?: IconName; ticket?: string }
  | { kind: "shell"; key: string; item: ShellItem; label: string; icon: IconName; ticket?: string };

export interface Skin {
  key: SkinKey;
  label: string;
  /** The menu's pinned entries, in order. Null: no pinned menu, every row in its group (the Standard shell). */
  pinned: readonly PinnedItem[] | null;
}

/** The Social Media team's design (plan §6.2). Kc draws it; rows whose page is not built yet carry the ticket that builds it. */
const SOCIAL_PINNED: readonly PinnedItem[] = [
  { kind: "row", key: "home", row: "overview", tab: "overview", label: "Home", icon: "home" },
  { kind: "shell", key: "search", item: "search", label: "Search", icon: "search" },
  { kind: "row", key: "messages", row: "messages", label: "Messages", ticket: "SCP-1j" },
  { kind: "shell", key: "notifications", item: "notifications", label: "Notifications", icon: "bell" },
  // The person's tasks (`/me/tasks`); Kc decides whether "given by me" and "whole team" open from there or from PM.
  { kind: "row", key: "tasks", row: "tasks", label: "Tasks" },
  { kind: "shell", key: "create", item: "create", label: "Create", icon: "plus" },
  { kind: "row", key: "calendar", row: "publish", tab: "calendar", label: "Calendar" },
  { kind: "row", key: "reports", row: "reports", label: "Reports" },
  { kind: "row", key: "saved", row: "saved", label: "Saved", ticket: "SCP-Kc" },
  { kind: "row", key: "profile", row: "profile", label: "Profile", ticket: "SCP-1k" },
  { kind: "row", key: "assistant", row: "assistant", label: "AI Assistant" },
  // The HoD and the GM: the Team view's gate (`reports.department.view` in the unit) is what shows it, not the skin.
  { kind: "row", key: "dashboard", row: "reports", tab: "team", label: "Dashboard" },
  { kind: "row", key: "settings", row: "settings", label: "Settings", ticket: "SCP-1c" },
];

export const SKINS: Readonly<Record<SkinKey, Skin>> = {
  standard: { key: "standard", label: "Standard", pinned: null },
  social: { key: "social", label: "Social", pinned: SOCIAL_PINNED },
};

/** The skins drawn for everyone. Standard always; Kg adds Social once SCP-1d, 1e and 1k are live (plan §8). */
export const SKINS_ON: readonly SkinKey[] = ["standard"];

/** The skins switched on: `SKINS_ON`, plus the comma-separated keys of `SHELL_SKIN_PREVIEW` (a dev or test box; unknown keys ignored). */
export function skinsOn(preview: string | undefined): SkinKey[] {
  const extra = (preview ?? "").split(",").map((s) => s.trim()).filter((s): s is SkinKey => (SKIN_KEYS as readonly string[]).includes(s));
  return [...new Set<SkinKey>([...SKINS_ON, ...extra])];
}

/** The skin a workspace is drawn in: its own when that skin is on and the person has not chosen Standard, else Standard. */
export function effectiveSkin(own: SkinKey | undefined, on: readonly SkinKey[], choice: SkinChoice = "workspace"): SkinKey {
  if (!own || choice === "standard" || !on.includes(own)) return "standard";
  return own;
}

/** A pinned entry made concrete for one person: a link to a page their model offers, or one of the shell's items. */
export type ConcretePinned =
  | { kind: "link"; key: string; label: string; icon: IconName; href: string; count?: number }
  | { kind: "shell"; key: string; item: ShellItem; label: string; icon: IconName };

/** The skin's pinned entries for a workspace's rows (the gated, settled rows the shell draws). Null for a skin with no pinned menu.
 *  An entry whose row or tab the person is not offered, or that is still planned, is dropped. A row's count rides on the entry that
 *  opens the row's first tab. */
export function pinnedFor(skin: SkinKey, rows: readonly ConcreteRow[]): ConcretePinned[] | null {
  const pinned = SKINS[skin].pinned;
  if (!pinned) return null;
  const out: ConcretePinned[] = [];
  for (const p of pinned) {
    if (p.ticket) continue;
    if (p.kind === "shell") {
      out.push({ kind: "shell", key: p.key, item: p.item, label: p.label, icon: p.icon });
      continue;
    }
    const row = rows.find((r) => r.key === p.row);
    const tab = row ? (p.tab ? row.tabs.find((t) => t.key === p.tab) : row.tabs[0]) : undefined;
    if (!row || !tab) continue;
    const count = tab === row.tabs[0] ? row.count : undefined;
    out.push({ kind: "link", key: p.key, label: p.label ?? row.label, icon: p.icon ?? row.icon, href: tab.href, ...(count ? { count } : {}) });
  }
  return out;
}
