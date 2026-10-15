"use server";
// The assistant workspace's left-rail collapse toggle persists into the SAME `gaiada_prefs` cookie
// density/width/theme already use (see lib/prefs.ts) — no new storage invented, per the ticket's
// own instruction. Its own tiny actions file rather than folded into `assistantActions.ts`: this
// preference belongs to `lib/prefs.ts` (a display setting, not assistant domain data), matching how
// `(app)/account/actions.ts::savePrefs` already owns the density/width/theme writes for the same
// cookie.
import { revalidatePath } from "next/cache";
import { getPrefs, writePrefs, type Theme, type OfficeZoom } from "./prefs";
import { parseShellLayout, type ShellLayout } from "./shellLayout";
import { MAX_PINNED_TOOLS, pinnedToolsFor } from "./pinnedTools";
import { GENERIC_WORKSPACE, isPlanned, workspaceBySlug } from "./workspaces";
import { MAX_OVERVIEW_KEYS, overviewPrefsFor, overviewWidgetsForKey } from "./overviewPrefs";

/** Fire-and-forget from `AssistantWorkspace`'s toggle click — the client already holds the
 *  authoritative UI state the instant it clicks (same "optimistic, not awaited for correctness" shape
 *  every other rail mutation in `assistantActions.ts` uses), so this only needs to make the NEXT
 *  page load remember it. No `revalidatePath`: nothing server-rendered reads this cookie on the
 *  current request, so there is no stale cache to invalidate. */
export async function setAssistantRailCollapsedAction(collapsed: boolean): Promise<void> {
  const current = await getPrefs();
  await writePrefs({ ...current, assistantRailCollapsed: collapsed });
}

/** Same shape as `setAssistantRailCollapsedAction` above — the TopBar theme toggle
 *  (`components/shell/ThemeToggle.tsx`) has already stamped `data-theme` on `<html>` itself before
 *  calling this, so the visible change never waits on a round trip; this only persists the choice
 *  for the next request (middleware-free routes like `/login` read `<html data-theme>` straight
 *  from `getPrefs()` in `app/layout.tsx`, so it has to land in the same cookie). No
 *  `revalidatePath`: the current page already reflects the change via the DOM write. */
export async function setThemeAction(theme: Theme): Promise<void> {
  const current = await getPrefs();
  await writePrefs({ ...current, theme });
}

/** Same optimistic shape as `setThemeAction` above — `OfficeCanvas.tsx` has already applied the
 *  zoom step (a pure CSS transform, see `lib/office.ts`'s camera math) before calling this; the
 *  visible change never waits on a round trip, this only persists the choice for the NEXT visit to
 *  `/office`. No `revalidatePath`: nothing else server-rendered reads this cookie. */
export async function setOfficeZoomAction(officeZoom: OfficeZoom): Promise<void> {
  const current = await getPrefs();
  await writePrefs({ ...current, officeZoom });
}

/** DW-1d: the per-person pilot switch (`lib/shellLayout.ts`). The argument comes from the browser, so it
 *  is parsed, and anything unknown stores the default. Unlike the actions above, the choice changes
 *  the server-rendered shell itself, so the whole app layout is revalidated. Nothing calls it until
 *  DW-2 gives the new shell a switch. */
export async function setShellLayoutAction(shell: ShellLayout): Promise<void> {
  const current = await getPrefs();
  await writePrefs({ ...current, shell: parseShellLayout(shell) });
  revalidatePath("/", "layout");
}

/** DW-6c: pin or unpin one tool of a workspace for the Overview's Today card (`lib/pinnedTools.ts`).
 *  Both arguments come from the browser. The workspace is re-resolved by key here, and a tool key that
 *  is not one of ITS tools is refused silently, with no write. The toggle starts from the EFFECTIVE pins
 *  (so unpinning one of the default six stores the other five), pinning a seventh is refused, and the
 *  list is stored in registry order. Works as a plain form post, so the page needs no JavaScript. */
export async function togglePinnedToolAction(workspaceKey: string, toolKey: string): Promise<void> {
  if (typeof workspaceKey !== "string" || typeof toolKey !== "string") return;
  const ws = workspaceKey === GENERIC_WORKSPACE.key ? GENERIC_WORKSPACE : workspaceBySlug(workspaceKey);
  if (!ws || !ws.tools.some((t) => t.key === toolKey)) return;
  const current = await getPrefs();
  const effective = pinnedToolsFor(current.pinnedTools, ws).map((t) => t.key);
  const isPinned = effective.includes(toolKey);
  if (!isPinned && effective.length >= MAX_PINNED_TOOLS) return;
  const next = isPinned ? effective.filter((k) => k !== toolKey) : [...effective, toolKey];
  const ordered = ws.tools.map((t) => t.key).filter((k) => next.includes(k));
  await writePrefs({ ...current, pinnedTools: { ...current.pinnedTools, [ws.key]: ordered } });
  revalidatePath("/", "layout");
}

/** DW-10d (DW-D34): hide or show one block of an Overview, or switch an optional one on or off (`lib/overviewPrefs.ts`).
 *  All three arguments come from the browser. The workspace is re-resolved by key here ("company" is the company list), and a
 *  widget that is not in THAT workspace's overview is refused silently, with no write. So are a `fixed` widget (Needs you and a
 *  head's condition banner cannot be hidden) and a widget that is still ticketed (not built, so not the person's to choose).
 *  `on` false on a default widget adds it to `hide`, true removes it; true on an optional widget adds it to `show`, false removes
 *  it. The other prefs are kept, and the lists are stored in registry order. Works as a plain form post, so the page needs no
 *  JavaScript. */
export async function setOverviewWidgetAction(workspaceKey: string, widgetKey: string, on: boolean): Promise<void> {
  if (typeof workspaceKey !== "string" || typeof widgetKey !== "string" || typeof on !== "boolean") return;
  const widgets = overviewWidgetsForKey(workspaceKey);
  const widget = widgets?.find((w) => w.key === widgetKey);
  if (!widgets || !widget || isPlanned(widget)) return;
  const placement = widget.placement ?? "default";
  if (placement === "fixed") return;
  const current = await getPrefs();
  const own = overviewPrefsFor(current.overview, workspaceKey);
  const listName = placement === "optional" ? "show" : "hide";
  // `hide` holds a hidden default widget (hiding = not on); `show` holds a switched-on optional one (showing = on).
  const inList = listName === "show" ? on : !on;
  const set = new Set(own[listName]);
  if (inList) set.add(widgetKey); else set.delete(widgetKey);
  if (set.size > MAX_OVERVIEW_KEYS) return;
  const ordered = widgets.map((w) => w.key).filter((k) => set.has(k));
  const entry = { hide: [...own.hide], show: [...own.show] };
  entry[listName] = ordered;
  const overview = { ...current.overview };
  if (entry.hide.length === 0 && entry.show.length === 0) delete overview[workspaceKey];
  else overview[workspaceKey] = entry;
  await writePrefs({ ...current, overview });
  revalidatePath("/", "layout");
}
