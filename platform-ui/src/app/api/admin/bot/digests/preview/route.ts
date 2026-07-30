import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";

// Read-only proxy for the Controls tab's digest PREVIEW control (ControlsTab.tsx): generates the
// digest text for one chat WITHOUT sending anything to WhatsApp — the whole point is letting an
// operator check what a digest says before it ever reaches a real group. Summarization is slow
// (the bot's route synchronously waits on the AI gateway for this one chat), so this can take a
// while; the client shows its own "generating…" state rather than a fast/slow distinction here.
export const dynamic = "force-dynamic";

interface DigestPreviewResult {
  chatId: string | null;
  digest: string | null;
  error?: string;
}

function json(body: DigestPreviewResult, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return json({ chatId: null, digest: null, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ chatId: null, digest: null, error: "Digest preview is limited to superadmins/owners." }, 403);
  }

  const url = new URL(req.url);
  const chatId = url.searchParams.get("chatId");
  const limit = url.searchParams.get("limit");
  if (!chatId) {
    return json({ chatId: null, digest: null, error: "Pick a group to preview." }, 400);
  }

  try {
    const qs = `chatId=${encodeURIComponent(chatId)}${limit ? `&limit=${encodeURIComponent(limit)}` : ""}`;
    const result = await platformFetch<{ chatId: string; digest: string }>(
      `/api/admin/bot/digests/preview?${qs}`,
      userId,
    );
    return json({ chatId: result.chatId, digest: result.digest });
  } catch (e) {
    if (e instanceof PlatformError && e.status === 404) {
      return json({ chatId: null, digest: null, error: e.message || "That group has no stored messages yet." }, 404);
    }
    if (e instanceof PlatformError && e.status === 502) {
      return json({ chatId: null, digest: null, error: "The bot isn't reachable right now — try again shortly." });
    }
    return json({ chatId: null, digest: null, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
