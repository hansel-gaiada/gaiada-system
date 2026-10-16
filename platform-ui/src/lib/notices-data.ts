import "server-only";
// DW-10a-2 (BFF §57.4): the notice board's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, so an empty list is evidence that there is nothing;
//   forbidden   a 403 (a unit outside the person's reporting line): they may not be told what is there;
//   unavailable anything else, a 404 included (an unknown unit, a route the platform does not serve): "cannot tell", never an empty list.
// A refusal or a failure is NEVER an empty board: "No current notices" is said only after a read that succeeded.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { NoticeList, NoticeQuery, NoticeRow, NoticeState } from "./notices";

export interface ListNoticesOptions {
  /** `current` (the default) or `past`. */
  state?: NoticeState;
  /** The opaque `nextCursor` of a previous page. */
  cursor?: string | null;
  /** 1 to 50; the backend's default is 20. */
  limit?: number;
}

const base = (tenantId: string) => `/api/${encodeURIComponent(tenantId)}/notices`;

function listPath(tenantId: string, query: NoticeQuery, opts: ListNoticesOptions): string {
  const p = new URLSearchParams();
  if (query.scope === "company") p.set("scope", "company");
  else p.set("unitNodeId", query.unitNodeId);
  p.set("state", opts.state ?? "current");
  if (opts.limit !== undefined) p.set("limit", String(opts.limit));
  if (opts.cursor) p.set("cursor", opts.cursor);
  return `${base(tenantId)}?${p.toString()}`;
}

/** The answer, checked: only `{items: [...], nextCursor}` counts. Anything else is a failed read, never an empty list. */
function asList(raw: unknown): NoticeList {
  const o = raw && typeof raw === "object" ? (raw as { items?: unknown; nextCursor?: unknown }) : null;
  if (!o || !Array.isArray(o.items)) throw new Error("the notices answer had no items");
  return { items: o.items as NoticeRow[], nextCursor: typeof o.nextCursor === "string" ? o.nextCursor : null };
}

/** `GET /notices?unitNodeId=U` or `?scope=company` (§57.4): the notices that reach U's people, pinned first when current. A 403 is
 *  "forbidden", and a 404 (an unknown unit) is "unavailable" with the backend's own words: the page never turns either into "none". */
export function listNotices(userId: string, tenantId: string, query: NoticeQuery, opts: ListNoticesOptions = {}): Promise<ReadResult<NoticeList>> {
  return readResult(platformFetch<unknown>(listPath(tenantId, query, opts), userId).then(asList));
}

/** The one sentence for a 404 on a single notice: "no such notice", "withdrawn" and "not yours to read" are one answer (never an
 *  existence oracle). */
export const NOTICE_NOT_FOUND = "This notice doesn't exist, was withdrawn, or isn't visible to you.";

/** `GET /notices/:id`. */
export async function getNotice(userId: string, tenantId: string, id: string): Promise<ReadResult<NoticeRow>> {
  const r = await readResult(platformFetch<NoticeRow>(`${base(tenantId)}/${encodeURIComponent(id)}`, userId));
  return r.kind === "unavailable" && /notice_not_found|\b404\b/.test(r.reason) ? { kind: "unavailable", reason: NOTICE_NOT_FOUND } : r;
}
