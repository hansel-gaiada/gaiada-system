"use server";
// The assistant workspace's left-rail collapse toggle persists into the SAME `gaiada_prefs` cookie
// density/width/theme already use (see lib/prefs.ts) — no new storage invented, per the ticket's
// own instruction. Its own tiny actions file rather than folded into `assistantActions.ts`: this
// preference belongs to `lib/prefs.ts` (a display setting, not assistant domain data), matching how
// `(app)/account/actions.ts::savePrefs` already owns the density/width/theme writes for the same
// cookie.
import { getPrefs, writePrefs, type Theme } from "./prefs";
import { revalidatePath } from "next/cache";

/** Fire-and-forget from `AssistantWorkspace`'s toggle click — the client already holds the
 *  authoritative UI state the instant it clicks (same "optimistic, not awaited for correctness" shape
 *  every other rail mutation in `assistantActions.ts` uses), so this only needs to make the NEXT
 *  page load remember it. No `revalidatePath`: nothing server-rendered reads this cookie on the
 *  current request, so there is no stale cache to invalidate. */
export async function setAssistantRailCollapsedAction(collapsed: boolean): Promise<void> {
  const current = await getPrefs();
  await writePrefs({ ...current, assistantRailCollapsed: collapsed });
}

/** P5-S1 — the appearance switch in the sidebar's account menu.
 *
 *  Deliberately NOT `(app)/account/actions.ts::savePrefs`: that action reads density and width out
 *  of its own form and falls back to "comfortable"/"standard" when they are absent — and the
 *  shipped default for width is "wide". Calling it with only a theme would silently reset a
 *  reader's content width. Same read-then-write shape as the rail toggle above instead, so the
 *  other three preferences pass through untouched.
 *
 *  `revalidatePath("/", "layout")` because the theme is applied as `data-theme` on <html> in
 *  app/layout.tsx: nothing short of re-rendering the root layout moves it. (The switch also sets
 *  that attribute directly on click, so the change lands on the frame the user clicked rather than
 *  after the round-trip — this is what makes the NEXT load agree.) */
export async function setThemeAction(theme: Theme): Promise<void> {
  const current = await getPrefs();
  await writePrefs({ ...current, theme });
  revalidatePath("/", "layout");
}
