import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";

// Read for the Controls tab's digest-preview group picker ONLY (ControlsTab.tsx) — proxies the
// already-existing nest route GET /api/admin/bot/groups (no new nest surface). Deliberately
// scoped under digests/** rather than a general-purpose /api/admin/bot/groups client route: the
// Groups tab's real registry CRUD surface (add/remove/ignore) is GroupRegistry.tsx's own
// server-rendered flow (systems/bot/page.tsx + group-actions.ts) and is out of scope here — this
// route exists only so the preview picker can list "groups" + "discovered" (both {id, name}),
// same shape the management-group dropdown is built from.
export const dynamic = "force-dynamic";

interface BotGroupOption {
  id: string;
  name?: string;
}

interface GroupsForPreview {
  groups: BotGroupOption[] | null;
  discovered: BotGroupOption[] | null;
  error?: string;
}

function json(body: GroupsForPreview, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return json({ groups: null, discovered: null, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ groups: null, discovered: null, error: "Digest preview is limited to superadmins/owners." }, 403);
  }

  try {
    const snapshot = await platformFetch<{ groups?: BotGroupOption[]; discovered?: BotGroupOption[] }>(
      "/api/admin/bot/groups",
      userId,
    );
    return json({ groups: snapshot?.groups ?? [], discovered: snapshot?.discovered ?? [] });
  } catch (e) {
    return json({
      groups: null,
      discovered: null,
      error: e instanceof PlatformError ? e.message : "bot admin unreachable",
    });
  }
}
