import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotSessionEvents, type BotSessionEvent } from "@/lib/admin";

// Read for the Logs tab's session-events timeline (LogsTab.tsx). Contract
// returns oldest-first; the UI re-sorts to newest-first for display.
export const dynamic = "force-dynamic";

interface EventsPoll {
  events: BotSessionEvent[] | null;
  error?: string;
}

function json(body: EventsPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return json({ events: null, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ events: null, error: "Session events are limited to superadmins/owners." }, 403);
  }

  try {
    const snapshot = await getBotSessionEvents(userId);
    return json({ events: snapshot.events });
  } catch (e) {
    return json({ events: null, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
