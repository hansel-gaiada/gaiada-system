"use server";
// The assistant workspace's left-rail collapse toggle persists into the SAME `gaiada_prefs` cookie
// density/width/theme already use (see lib/prefs.ts) — no new storage invented, per the ticket's
// own instruction. Its own tiny actions file rather than folded into `assistantActions.ts`: this
// preference belongs to `lib/prefs.ts` (a display setting, not assistant domain data), matching how
// `(app)/account/actions.ts::savePrefs` already owns the density/width/theme writes for the same
// cookie.
import { getPrefs, writePrefs } from "./prefs";

/** Fire-and-forget from `AssistantWorkspace`'s toggle click — the client already holds the
 *  authoritative UI state the instant it clicks (same "optimistic, not awaited for correctness" shape
 *  every other rail mutation in `assistantActions.ts` uses), so this only needs to make the NEXT
 *  page load remember it. No `revalidatePath`: nothing server-rendered reads this cookie on the
 *  current request, so there is no stale cache to invalidate. */
export async function setAssistantRailCollapsedAction(collapsed: boolean): Promise<void> {
  const current = await getPrefs();
  await writePrefs({ ...current, assistantRailCollapsed: collapsed });
}
