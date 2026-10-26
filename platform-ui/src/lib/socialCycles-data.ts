import "server-only";
// SCP-1c (BFF §63.4, §63.5): the Settings page's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty table.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asCycleTable, asSocialSettings, type CycleTable, type SocialSettings } from "./socialCycles";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET settings` (social_post · read): the buffer, the boost-candidate factor, whether a holiday calendar is known, and whether the caller may plan. */
export function getSocialSettings(userId: string, tenantId: string): Promise<ReadResult<SocialSettings>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/settings`, userId).then(asSocialSettings));
}

/** `GET cycles?month=YYYY-MM` (social_post · read): the deadline table of one month. */
export function getCycleTable(userId: string, tenantId: string, month: string): Promise<ReadResult<CycleTable>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/cycles?month=${encodeURIComponent(month)}`, userId).then(asCycleTable));
}
