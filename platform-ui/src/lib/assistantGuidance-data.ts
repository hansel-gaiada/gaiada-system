import "server-only";
// AIP-13b (BFF §65.2): the department assistant guidance reader. One egress (`platformFetch`). Unlike `ReadResult`, a 404 is a real answer here
// (the server says `department_not_found` for an authorized caller who names a unit that is not an active department of this company), so it
// is its own variant and the page says so; a 403 is "forbidden", and anything else is "cannot tell", never an empty text.
import { platformFetch, PlatformError } from "./platform";
import { asPreambleView, type PreambleView } from "./assistantGuidance";

export type GuidanceRead =
  | { kind: "ok"; data: PreambleView }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: string };

/** The route's address for one unit. The unit id is the org node id the page already carries. */
export const preamblePath = (tenantId: string, unitNodeId: string): string =>
  `/api/${encodeURIComponent(tenantId)}/departments/${encodeURIComponent(unitNodeId)}/assistant-preamble`;

/** `GET /departments/:unitNodeId/assistant-preamble` (§65.2). */
export async function getAssistantPreamble(userId: string, tenantId: string, unitNodeId: string): Promise<GuidanceRead> {
  try {
    return { kind: "ok", data: asPreambleView(await platformFetch<unknown>(preamblePath(tenantId, unitNodeId), userId)) };
  } catch (err) {
    if (err instanceof PlatformError) {
      if (err.status === 403) return { kind: "forbidden" };
      if (err.status === 404) return { kind: "not_found" };
      return { kind: "unavailable", reason: err.message };
    }
    return { kind: "unavailable", reason: (err as Error)?.message ?? "unknown error" };
  }
}
