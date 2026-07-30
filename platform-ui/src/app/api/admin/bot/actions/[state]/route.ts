import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { isElevated } from "@/lib/rbac";

// Mutation for the Controls tab's actions kill switch (ControlsTab.tsx).
// Turning actions OFF is the safe direction (the component fires this
// immediately on click); turning them back ON re-arms the bot's ability to
// mutate real WhatsApp groups, so the component gates that call behind an
// explicit confirm before this route is ever reached. Either way, the
// component reconciles its displayed state from THIS response's `enabled` —
// never an optimistic flip — since this is a real safety control.
export const dynamic = "force-dynamic";

interface ActionsResult {
  enabled: boolean | null;
  error?: string;
}

function json(body: ActionsResult, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const VALID_STATES = new Set(["on", "off"]);

export async function POST(_req: Request, { params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  const userId = await getSessionUserId();
  if (!userId) return json({ enabled: null, error: "Session expired — sign in again." }, 401);

  const me = await getMe(userId).catch(() => null);
  if (!me || !isElevated(me)) {
    return json({ enabled: null, error: "The actions kill switch is limited to superadmins/owners." }, 403);
  }

  if (!VALID_STATES.has(state)) {
    return json({ enabled: null, error: "state must be on or off" }, 400);
  }

  try {
    // The bot is inconsistent with itself here: GET /admin/actions/audit answers {enabled},
    // but POST /admin/actions/:state answers {actionsEnabled}. Reading only `enabled` made a
    // SUCCESSFUL flip report "Could not change the actions switch" — the worst possible lie for
    // a safety control. Accept either key rather than changing the bot's long-standing response
    // shape (the kill switch predates this console and may have other consumers).
    const body = await platformFetch<{ enabled?: boolean; actionsEnabled?: boolean }>(
      `/api/admin/bot/actions/${state}`,
      userId,
      { method: "POST" },
    );
    const enabled = body.actionsEnabled ?? body.enabled;
    if (typeof enabled !== "boolean") {
      return json({ enabled: null, error: "The bot did not report the switch state — re-check it before relying on it." });
    }
    return json({ enabled });
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 502 || e.status === 404)) {
      return json({ enabled: null, error: "The bot isn't reachable right now — try again shortly." });
    }
    return json({ enabled: null, error: e instanceof PlatformError ? e.message : "bot admin unreachable" });
  }
}
