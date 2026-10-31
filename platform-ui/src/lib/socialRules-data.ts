import "server-only";
// SCP-5 W5-C5 (BFF §63.30.4): the company rules' reader. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person may not read the rules, which is not "the rules are the defaults";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never defaults posing as the company's values.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asRulesAnswer, type RulesAnswer } from "./socialRules";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET rules` (`social_post` · `read`): the company's rules, the seed beside them, who changed each section and when, and `canEdit`. */
export function getRules(userId: string, tenantId: string): Promise<ReadResult<RulesAnswer>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/rules`, userId).then(asRulesAnswer));
}
