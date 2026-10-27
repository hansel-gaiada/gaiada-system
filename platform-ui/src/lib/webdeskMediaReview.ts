import "server-only";
// M5-W1q (WSK-D84) -- the review desk's server read: the contributor uploads waiting for a staff decision on one site. A NEW module on
// purpose (the same reason `webdeskMedia.ts` is one: the nest suite loads `webdeskContent*.ts` into its own runner). It reuses
// `mediaCall`, so every 2xx body is validated (`contract_drift` on a mismatch) and no failure turns into an empty list: a 403 is
// "you can't review here", never "nothing is waiting".
import { mediaBase, mediaCall } from "./webdeskMedia";
import type { WdResult } from "./webdeskContentModel";
import { parseQuarantine, type QuarantineBody } from "./webdeskMediaReviewModel";

export function quarantineQuery(cursor?: string, limit = 50): string {
  const p = new URLSearchParams();
  if (cursor) p.set("cursor", cursor);
  p.set("limit", String(Math.min(Math.max(limit, 1), 100)));
  return p.toString();
}

export async function listQuarantine(userId: string, company: string, tenantSlug: string, siteId: string, cursor?: string): Promise<WdResult<QuarantineBody>> {
  const r = await mediaCall(`${mediaBase(company, tenantSlug, siteId)}/quarantine?${quarantineQuery(cursor)}`, userId, parseQuarantine);
  return r as WdResult<QuarantineBody>; // a list read is never `in_use`
}
