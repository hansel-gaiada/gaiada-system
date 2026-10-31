import "server-only";
// SCP-5 W5-A4 (BFF §63.25.3): the ideas' reader. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the client is gone included): "cannot tell", never an empty list.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asIdeaList, type Idea } from "./socialIdeas";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET engagements/:engagementId/ideas` (`social_post` · `read`): the client's ideas, newest first, at most 200, with the server's `canWrite` for this person. */
export function getIdeas(userId: string, tenantId: string, engagementId: string): Promise<ReadResult<{ items: Idea[]; canWrite: boolean }>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/engagements/${encodeURIComponent(engagementId)}/ideas`, userId).then(asIdeaList));
}
