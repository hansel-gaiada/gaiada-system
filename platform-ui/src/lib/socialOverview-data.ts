import "server-only";
// SCP-3f (BFF §63.7): the reader of `GET overview` (social_post · read). One egress (`platformFetch`), the answer a `ReadResult`: a 403 is `forbidden`, anything
// else that is not the contract's shape is `unavailable` ("cannot tell"), never zeroes.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asOverview, type SocialOverview } from "./socialOverview";

export function getOverview(userId: string, tenantId: string): Promise<ReadResult<SocialOverview>> {
  return readResult(platformFetch<unknown>(`/api/${encodeURIComponent(tenantId)}/modules/social/overview`, userId).then(asOverview));
}
