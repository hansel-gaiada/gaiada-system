import "server-only";
// SCP-1a (BFF §63.4): the Allocation page's readers (and the Settings page's step estimates). One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty list.
import { platformFetch } from "./platform";
import { listMembers, type Member } from "./entities";
import { readResult, type ReadResult } from "./readResult";
import { asAllocationRows, type AllocationRow } from "./socialAllocation";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET allocation` (social_engagement · read): every open client with its allocation and this cycle's counts; `mine` keeps the caller's clients. */
export function getAllocation(userId: string, tenantId: string, opts: { mine?: boolean } = {}): Promise<ReadResult<AllocationRow[]>> {
  const qs = opts.mine ? "?mine=1" : "";
  return readResult(platformFetch<unknown>(`${base(tenantId)}/allocation${qs}`, userId).then(asAllocationRows));
}

/** The company's members, for the officer picker. A failed read leaves the picker with the current officers only (the page says so). */
export function getOfficerCandidates(userId: string, tenantId: string): Promise<ReadResult<Member[]>> {
  return readResult(listMembers(userId, tenantId));
}
