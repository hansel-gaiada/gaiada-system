import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotSearch, type BotSearchResult } from "@/lib/admin";

// Read for the Chats tab's cross-chat MESSAGE search (distinct from the chat-list filter, which
// goes through api/admin/bot/chats' own `q`/`kind` params). Frozen nest contract
// `GET /api/admin/bot/search` -> bot `GET /admin/search` (contract §1e). Read-only, no-store,
// same fail-soft shape as every other bot admin proxy route in this app.
export const dynamic = "force-dynamic";

interface SearchPoll {
  results: BotSearchResult[] | null;
  error?: string;
}

function json(body: SearchPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return json({ results: null, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ results: null, error: "Message search is limited to superadmins/owners." }, 403);
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25;

  if (!q.trim()) return json({ results: [] });

  try {
    const snapshot = await getBotSearch(userId, q, limit);
    return json({ results: snapshot?.results ?? [] });
  } catch (e) {
    return json({ results: null, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
