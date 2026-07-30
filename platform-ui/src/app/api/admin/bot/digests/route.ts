import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotDigests, type BotDigestRecord } from "@/lib/admin";

// Read for the Controls tab's Digests panel (ControlsTab.tsx) — next
// scheduled run per slot + a newest-first run history. Mirrors
// api/admin/bot/actions/audit/route.ts's fail-soft shape: `history` is the
// null-sentinel the client checks (see ControlsTab), a missing/unreachable
// bot admin API degrades to an empty history rather than an error.
export const dynamic = "force-dynamic";

interface DigestsPoll {
  history: BotDigestRecord[] | null;
  nextRun: { noon: number | null; evening: number | null } | null;
  timezone: string | null;
  error?: string;
}

function json(body: DigestsPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) {
    return json({ history: null, nextRun: null, timezone: null, error: "Session expired — sign in again." }, 401);
  }

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json(
      { history: null, nextRun: null, timezone: null, error: "Digest history is limited to superadmins/owners." },
      403,
    );
  }

  try {
    const snapshot = await getBotDigests(userId);
    return json({
      history: snapshot?.history ?? [],
      nextRun: snapshot?.nextRun ?? { noon: null, evening: null },
      timezone: snapshot?.timezone ?? "",
    });
  } catch (e) {
    return json({
      history: null,
      nextRun: null,
      timezone: null,
      error: e instanceof PlatformError ? e.message : "bot admin unreachable",
    });
  }
}
