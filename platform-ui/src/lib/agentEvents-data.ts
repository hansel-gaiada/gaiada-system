import "server-only";
// O4 — the platformFetch reader for the run-events proxy platform-nest exposes at
// `GET /api/:tenantId/agents/runs/:runId/events?since=<seq>`
// (platform-nest/src/admin/intelligence.controller.ts's `agentRunEvents`, gated exactly like the
// sibling `getAgentRun`/`agentRun` in lib/admin.ts). Split into its own server-only file rather
// than folded into admin.ts so the pure types + `findSeqGaps` in the sibling `agentEvents.ts`
// stay client-importable — see that file's header for why admin.ts's existing shape couldn't
// offer that split for free.
import { platformFetch, PlatformError } from "./platform";
import type { AgentRunEvent } from "./agentEvents";

/** Absorbs 404 (runner/route not available) and 403 (not elevated, and not this handoff run's
 *  owner) into an empty page — same "degrade, don't throw" convention as `lib/admin.ts`'s
 *  `skipUnavailable`. A poller should read "nothing available" as "nothing new yet", not crash
 *  the office canvas mid-render. `sinceSeq` defaults to 0 (the whole history so far), matching
 *  the runner's own `since` default. */
export async function getAgentRunEvents(
  userId: string,
  tenantId: string,
  runId: string,
  sinceSeq = 0,
): Promise<AgentRunEvent[]> {
  const qs = new URLSearchParams({ since: String(Math.max(sinceSeq, 0)) });
  try {
    const res = await platformFetch<{ events?: AgentRunEvent[] }>(
      `/api/${tenantId}/agents/runs/${runId}/events?${qs.toString()}`,
      userId,
    );
    return Array.isArray(res?.events) ? res.events : [];
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return [];
    throw e;
  }
}
