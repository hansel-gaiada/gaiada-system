import "server-only";
// SCP-Sb (BFF §63.1 file 8): the client page's reader of one client's social accounts (`GET accounts?clientId=`, social_account · read). A `ReadResult`: a refusal
// or a failure is said in words, never drawn as "no accounts".
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asClientAccounts } from "./socialSimulatedAccounts";
import type { SocialAccount } from "./socialShared";

export function getClientAccounts(userId: string, tenantId: string, clientId: string): Promise<ReadResult<SocialAccount[]>> {
  const qs = new URLSearchParams({ clientId });
  return readResult(
    platformFetch<unknown>(`/api/${encodeURIComponent(tenantId)}/modules/social/accounts?${qs.toString()}`, userId).then(asClientAccounts),
    { absentAsEmpty: [] },
  );
}
