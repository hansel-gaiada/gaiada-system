import "server-only";
// SCP-1h (BFF §63.6.6): the design queue's reader. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names (an empty list is evidence: nothing to design);
//   forbidden   a 403 on the outer gate: not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty queue.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asDesignQueue, DESIGN_QUEUE_PAGE_SIZE, type DesignQueuePage } from "./socialDesignQueue";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET design-queue?cursor=&limit=` (work_request · read, each row narrowed on the server by the caller's two design facts). */
export function getDesignQueue(userId: string, tenantId: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<ReadResult<DesignQueuePage>> {
  const qs = new URLSearchParams({ limit: String(opts.limit ?? DESIGN_QUEUE_PAGE_SIZE) });
  if (opts.cursor) qs.set("cursor", opts.cursor);
  return readResult(platformFetch<unknown>(`${base(tenantId)}/design-queue?${qs.toString()}`, userId).then(asDesignQueue));
}
