import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";
import { getBotActionAudit, type BotActionAuditEntry } from "@/lib/admin";

// Read for the Logs tab's action-audit table (LogsTab.tsx). Entries are
// rendered generically by the UI — this route just forwards whatever shape
// nest sends.
export const dynamic = "force-dynamic";

interface AuditPoll {
  enabled: boolean;
  entries: BotActionAuditEntry[] | null;
  error?: string;
}

function json(body: AuditPoll, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return json({ enabled: false, entries: null, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ enabled: false, entries: null, error: "The action audit is limited to superadmins/owners." }, 403);
  }

  try {
    const snapshot = await getBotActionAudit(userId);
    return json({ enabled: snapshot?.enabled ?? false, entries: snapshot?.entries ?? [] });
  } catch (e) {
    return json({ enabled: false, entries: null, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
