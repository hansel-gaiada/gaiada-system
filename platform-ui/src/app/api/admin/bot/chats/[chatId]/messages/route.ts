import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotChatMessages, type BotChatMessage } from "@/lib/admin";

// Poll read for the Chats tab's right pane (message thread). The browser
// polls this every ~6s while a chat is selected (ChatsTab.tsx), passing the
// chatId URL-encoded in the request path (it contains "@"/":" — WA JIDs and
// "tg:<id>"). Next.js decodes the [chatId] segment for us; getBotChatMessages
// re-encodes it before it goes out to the platform-nest proxy, per the
// contract's own note.
export const dynamic = "force-dynamic";

interface MessagesPoll {
  messages: BotChatMessage[] | null;
  hasMore?: boolean;
  error?: string;
}

function json(body: MessagesPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  const userId = await getSessionUserId();
  if (!userId) return json({ messages: null, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ messages: null, error: "Chat viewer is limited to superadmins/owners." }, 403);
  }

  // `beforeTs` is additive ("Load older" paging in ChatsTab) — absent on the normal/poll fetch.
  const beforeTsRaw = new URL(req.url).searchParams.get("beforeTs");
  const beforeTs = beforeTsRaw != null && beforeTsRaw !== "" ? Number(beforeTsRaw) : undefined;

  try {
    const snapshot = await getBotChatMessages(userId, chatId, Number.isFinite(beforeTs) ? beforeTs : undefined);
    return json({ messages: snapshot?.messages ?? [], hasMore: snapshot?.hasMore ?? false });
  } catch (e) {
    return json({ messages: null, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
