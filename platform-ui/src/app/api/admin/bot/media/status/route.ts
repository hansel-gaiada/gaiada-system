import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotMediaStatus } from "@/lib/admin";

// Read for the Controls tab's "Media queue" panel — queue on/off, pending
// backlog count and the oldest pending item's age. A large backlog with an
// old timestamp is the signal that enrichment is stuck; the component makes
// that readable rather than this route doing any interpretation.
export const dynamic = "force-dynamic";

interface MediaStatusPoll {
  queueEnabled: boolean | null;
  pending: number | null;
  oldestPendingTs: number | null;
  error?: string;
}

function json(body: MediaStatusPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return json({ queueEnabled: null, pending: null, oldestPendingTs: null, error: "Session expired — sign in again." }, 401);
  }

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json(
      { queueEnabled: null, pending: null, oldestPendingTs: null, error: "Media queue status is limited to superadmins/owners." },
      403,
    );
  }

  try {
    const snapshot = await getBotMediaStatus(userId);
    return json({
      queueEnabled: snapshot?.queueEnabled ?? false,
      pending: snapshot?.pending ?? 0,
      oldestPendingTs: snapshot?.oldestPendingTs ?? null,
    });
  } catch (e) {
    return json({
      queueEnabled: null,
      pending: null,
      oldestPendingTs: null,
      error: e instanceof PlatformError ? e.message : "bot admin unreachable",
    });
  }
}
