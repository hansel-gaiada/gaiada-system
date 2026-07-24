"use server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";

// Mutations for the Connect WhatsApp surface (A5, doc §2.5). Every call
// proxies through platform-nest's `api/admin/bot/session/*` (doc §2.4), which
// holds the bot admin token and re-enforces `isElevated` on every route — the
// isElevated check here is cosmetic/defense-in-depth (UI gating is never the
// security boundary), matching the ctx() pattern in lib/billingActions.ts.
export interface BotSessionActionState {
  ok: boolean;
  error?: string;
}

async function ctx() {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." } as const;
  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return { error: "WhatsApp connection controls are limited to superadmins/owners." } as const;
  }
  return { userId } as const;
}

async function post(path: string, userId: string): Promise<BotSessionActionState> {
  try {
    await platformFetch(path, userId, { method: "POST" });
    return { ok: true };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 502 || e.status === 404) {
        return { ok: false, error: "The bot isn't reachable right now — try again shortly." };
      }
      return { ok: false, error: e.message };
    }
    throw e;
  }
}

export async function startBotSession(
  _prev: BotSessionActionState | null,
  _formData: FormData,
): Promise<BotSessionActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  return post("/api/admin/bot/session/start", c.userId);
}

export async function stopBotSession(
  _prev: BotSessionActionState | null,
  _formData: FormData,
): Promise<BotSessionActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  return post("/api/admin/bot/session/stop", c.userId);
}

export async function restartBotSession(
  _prev: BotSessionActionState | null,
  _formData: FormData,
): Promise<BotSessionActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  return post("/api/admin/bot/session/restart", c.userId);
}

// Logout UNPAIRS the WhatsApp number (next start needs a fresh QR scan) — the
// component gates this behind a confirm step before this action ever fires.
export async function logoutBotSession(
  _prev: BotSessionActionState | null,
  _formData: FormData,
): Promise<BotSessionActionState> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  return post("/api/admin/bot/session/logout", c.userId);
}
