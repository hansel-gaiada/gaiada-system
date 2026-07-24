"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import type { BotGroupConfig } from "@/components/systems/GroupRegistry";

// Mutation for the Group registry surface (A6, doc §2.3/2.4/2.5). Full-replace
// PUT to platform-nest's `api/admin/bot/groups`, which re-enforces isElevated
// and forwards to the bot for validation — the isElevated check here is
// cosmetic/defense-in-depth, same convention as session-actions.ts.
export interface GroupsActionState {
  ok: boolean;
  error?: string;
  field?: string;
}

export async function updateBotGroups(groups: BotGroupConfig[]): Promise<GroupsActionState> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return { ok: false, error: "Group registry edits are limited to superadmins/owners." };
  }

  try {
    await platformFetch("/api/admin/bot/groups", userId, {
      method: "PUT",
      body: JSON.stringify({ groups }),
    });
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 502 || e.status === 404) {
        return { ok: false, error: "The bot isn't reachable right now — try again shortly." };
      }
      return { ok: false, error: e.message, field: e.field };
    }
    throw e;
  }

  revalidatePath("/systems/bot");
  return { ok: true };
}
