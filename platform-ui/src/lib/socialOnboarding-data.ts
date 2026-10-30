import "server-only";
// SCP-5h (BFF §63.29.4): the onboarding page's reader. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty list.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asOnboarding, type Onboarding } from "./socialOnboarding";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET onboarding` (`social_post` · `read`): the clients being onboarded, each with progress, the next step, the kickoff, the checklist and the baseline audit. */
export function getOnboarding(userId: string, tenantId: string): Promise<ReadResult<Onboarding>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/onboarding`, userId).then(asOnboarding));
}
