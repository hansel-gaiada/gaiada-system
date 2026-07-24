import { NextResponse, type NextRequest } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getAgentGoals, getAgentGoal } from "@/lib/admin";

// Poll route for the /agents console (B4, doc §3.4 "poll route handler ...
// for the running-goal refresh"). GET, no-store, server-side platformFetch —
// mirrors the A5 bot session poll route's shape/rationale: the client-side
// poller can't call platform-nest directly (no token in the browser), so it
// polls this same-origin route, which re-derives the session/tenant server-
// side exactly like any page render.
//
// One route covers both polling needs this ticket has:
//   GET /api/admin/agents/goals            -> { goals: AgentGoal[] }        (the /agents table)
//   GET /api/admin/agents/goals?goalId=<id> -> { goal: AgentGoalDetail|null } (the goal detail page)
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  const goalId = req.nextUrl.searchParams.get("goalId");
  const body = !tenant
    ? goalId
      ? { goal: null }
      : { goals: [] }
    : goalId
      ? { goal: await getAgentGoal(userId, tenant, goalId) }
      : { goals: await getAgentGoals(userId, tenant) };

  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
