import { NextResponse, type NextRequest } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getAgentRunEvents } from "@/lib/agentEvents-data";

// O4 — poll route for the office canvas's real (non-demo) agent activity feed. Same shape/
// rationale as the sibling `admin/agents/goals/route.ts` (B4) and `meetings/[id]/status`: the
// browser cannot call platform-nest directly (no token reaches it — `platformFetch` is the only
// egress and it is `server-only`), so it polls this same-origin route, which re-derives the
// session/tenant server-side exactly like any page render, then reads the `since=` cursor
// straight through to `getAgentRunEvents` (lib/agentEvents-data.ts).
//
// GET /api/admin/agents/runs/:runId/events?since=<seq> -> { events: AgentRunEvent[] }
//
// Polling, not SSE — see intelligence.controller.ts's `agentRunEvents` for the full justification
// (chaining SSE through platform-nest -> agent-runner adds a second long-lived-connection
// failure mode for a single-replica in-process bus that can't fan out across platform-nest
// instances anyway); this route mirrors that decision rather than re-litigating it.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return NextResponse.json({ events: [] }, { headers: { "Cache-Control": "no-store" } });

  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = Math.max(Number(sinceRaw ?? 0) || 0, 0);

  const events = await getAgentRunEvents(userId, tenant, runId, since);
  return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
}
