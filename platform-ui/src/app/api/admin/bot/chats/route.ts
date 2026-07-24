import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotChats, type BotChatsSnapshot } from "@/lib/admin";

// Poll read for the Chats tab's left pane (chat list). The browser polls this
// every ~15s while the Chats tab is mounted (ChatsTab.tsx). Server-side
// platformFetch only — mirrors api/admin/bot/session/route.ts's fail-soft
// contract (never cached; nest re-enforces isElevated on its own).
export const dynamic = "force-dynamic";

interface ChatsPoll {
  chats: BotChatsSnapshot["chats"] | null;
  error?: string;
}

function json(body: ChatsPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return json({ chats: null, error: "Session expired — sign in again." }, 401);

  // Cosmetic gate (defense-in-depth) — the real boundary is nest's own
  // isElevated check on api/admin/bot/*.
  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ chats: null, error: "Chat viewer is limited to superadmins/owners." }, 403);
  }

  try {
    const snapshot = await getBotChats(userId);
    return json({ chats: snapshot?.chats ?? [] });
  } catch (e) {
    return json({ chats: null, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
