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
// on: `SKINS_ON` in code (Social since SCP-Kg), or `SHELL_SKIN_PREVIEW` on a dev or test box.
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
 *  dropped when the person is not offered that row or tab, unless `tabFallback` is set: then a tab the model lacks (one a later ticket
 *  builds) opens the row's first tab instead. `ticket` marks an entry whose page is not built yet: never rendered while set, as in the
 *  registry. */
export type PinnedItem =
  | { kind: "row"; key: string; row: string; tab?: string; tabFallback?: boolean; label?: string; icon?: IconName; ticket?: string }
  | { kind: "shell"; key: string; item: ShellItem; label: string; icon: IconName; ticket?: string };

export interface Skin {
  key: SkinKey;
  label: string;
  /** The menu's pinned entries, in order. Null: no pinned menu, every row in its group (the Standard shell). */
  pinned: readonly PinnedItem[] | null;
  /** On a phone (SCP-Ke): the keys of the pinned entries drawn in the bottom bar, in order. An entry that is not offered (ticketed, or a row the person
   *  lacks) is simply absent from the bar. */
  phoneBar: readonly string[];
  /** On a phone: the keys drawn at the top right of the top bar, in order. Whatever is in neither list is listed in the More sheet's first section. */
  phoneTop: readonly string[];
}

/** The Social Media team's design (plan §6.2). Kc draws it; rows whose page is not built yet carry the ticket that builds it. */
const SOCIAL_PINNED: readonly PinnedItem[] = [
  { kind: "row", key: "home", row: "overview", tab: "overview", label: "Home", icon: "home" },
  { kind: "shell", key: "search", item: "search", label: "Search", icon: "search" },
  { kind: "row", key: "messages", row: "messages", label: "Messages", icon: "messages", ticket: "SCP-1j" },
  { kind: "shell", key: "notifications", item: "notifications", label: "Notifications", icon: "heart" },
  // The person's tasks (`/me/tasks`); "given by me" and "whole team" stay in Project Management, under More.
  { kind: "row", key: "tasks", row: "tasks", label: "Tasks", icon: "tasks" },
  { kind: "shell", key: "create", item: "create", label: "Create", icon: "createSquare" },
  { kind: "row", key: "calendar", row: "publish", tab: "calendar", label: "Calendar", icon: "calendar" },
  // The Social reports tab (`{D}/social-reports`) is SCP-5a's; until it is in the model this opens the shared Reports row's first tab.
  { kind: "row", key: "reports", row: "reports", tab: "social", tabFallback: true, label: "Reports", icon: "chart" },
  // The asset library (`{D}/assets`, the `assets` tab of the Social Media toolkit).
  { kind: "row", key: "saved", row: "publish", tab: "assets", label: "Saved", icon: "bookmark" },
  { kind: "row", key: "profile", row: "profile", label: "Profile", icon: "user", ticket: "SCP-1k" },
  { kind: "row", key: "assistant", row: "assistant", label: "AI Assistant" },
  // A future Social page ({D}/dashboard, for the four Social approvers).
  { kind: "row", key: "dashboard", row: "dashboard", label: "Dashboard", icon: "dashboard", ticket: "SCP-5d" },
  { kind: "row", key: "settings", row: "settings", label: "Settings", icon: "settings" },
];

export const SKINS: Readonly<Record<SkinKey, Skin>> = {
  standard: { key: "standard", label: "Standard", pinned: null, phoneBar: [], phoneTop: [] },
  // The design's phone: bottom bar Home, Search, Create, Tasks, Profile; Notifications and Messages at the top (plan §6.2).
  social: {
    key: "social", label: "Social", pinned: SOCIAL_PINNED,
    phoneBar: ["home", "search", "create", "tasks", "profile"],
    phoneTop: ["notifications", "messages"],
  },
};

/** The skins drawn for everyone. Standard always; Social since SCP-Kg, switched on by the owner on 2026-10-27 ahead of SCP-1d, 1e and 1k (plan §8
 *  had it wait for them). No pinned entry points at a page that does not exist: Messages, Profile, Dashboard and Settings keep their `ticket` and
 *  stay hidden until their pages land. Anyone may still choose the Standard look for themselves (More › Appearance). */
export const SKINS_ON: readonly SkinKey[] = ["standard", "social"];

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

/** A pinned entry made concrete for one person: a link to a page their model offers, or one of the shell's items. A link names the row
 *  and tab it opens (`row`, `tab`), so the menu can tell which entry the current page belongs to; `wholeRow` marks an entry that stands
 *  for its whole row (it fell back to the row's first tab, or named no tab). */
export type ConcretePinned =
  | { kind: "link"; key: string; label: string; icon: IconName; href: string; row: string; tab: string; wholeRow: boolean; count?: number }
  | { kind: "shell"; key: string; item: ShellItem; label: string; icon: IconName };

/** The skin's pinned entries for a workspace's rows (the gated, settled rows the shell draws). Null for a skin with no pinned menu.
 *  An entry whose row or tab the person is not offered, or that is still planned, is dropped. A row's count rides on the entry that opens
 *  the row's first tab. */
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
    if (!row) continue;
    const named = p.tab ? row.tabs.find((t) => t.key === p.tab) : row.tabs[0];
    const fellBack = !named && !!p.tabFallback;
    const tab = named ?? (fellBack ? row.tabs[0] : undefined);
    if (!tab) continue;
    const count = tab === row.tabs[0] ? row.count : undefined;
    out.push({
      kind: "link", key: p.key, label: p.label ?? row.label, icon: p.icon ?? row.icon, href: tab.href, row: row.key, tab: tab.key,
      wholeRow: !p.tab || p.tabFallback === true, ...(count ? { count } : {}),
    });
  }
  return out;
}

/** The pinned entry the current page belongs to, by key (or null). `active` is the shell's own answer (`activeLocation`: the deepest tab
 *  prefix across every row of the workspace), so an unpinned page lights nothing instead of lighting Home for being a prefix. An entry
 *  matches when it opens the active row and either stands for its whole row or opens the active tab. */
export function activePinKey(pins: readonly ConcretePinned[], active: { rowKey: string; tabKey: string } | null): string | null {
  if (!active) return null;
  return pins.find((p) => p.kind === "link" && p.row === active.rowKey && (p.wholeRow || p.tab === active.tabKey))?.key ?? null;
}

/** The entries of `pins` named by `keys`, in the order of `keys` (an entry that is not in `pins` is absent). */
const pickPins = (pins: readonly ConcretePinned[], keys: readonly string[]): ConcretePinned[] =>
  keys.flatMap((k) => pins.find((p) => p.key === k) ?? []);

/** The phone's bottom bar for a skin (SCP-Ke): its `phoneBar` entries the person is offered, in the skin's order. */
export const phoneBarFor = (skin: SkinKey, pins: readonly ConcretePinned[]): ConcretePinned[] => pickPins(pins, SKINS[skin].phoneBar);

/** The phone's top-right entries for a skin: its `phoneTop` entries the person is offered, in order. */
export const phoneTopFor = (skin: SkinKey, pins: readonly ConcretePinned[]): ConcretePinned[] => pickPins(pins, SKINS[skin].phoneTop);

/** The pinned links a phone has no other place for: neither in the bottom bar nor at the top (a phone has no menu column), in the menu's order.
 *  The More sheet lists them first, so every pinned page, the AI Assistant included, stays one tap away. Shell entries are always in the bar or at the top. */
export function phoneMenuFor(skin: SkinKey, pins: readonly ConcretePinned[]): Extract<ConcretePinned, { kind: "link" }>[] {
  const placed = new Set([...SKINS[skin].phoneBar, ...SKINS[skin].phoneTop]);
  return pins.filter((p): p is Extract<ConcretePinned, { kind: "link" }> => p.kind === "link" && !placed.has(p.key));
}
