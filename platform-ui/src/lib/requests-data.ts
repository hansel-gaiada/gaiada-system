import "server-only";
// DW-5c UI: readers behind /requests, /requests/new, /requests/[id] and the Sent tab (docs/FRONTEND-BFF-CONTRACT.md
// §32.5). Every reader returns a `ReadResult`: a refusal or a failed read is DATA the page renders with <ReadRefusal>,
// never an empty list that reads as "no requests" (plan trap 4: a failed read says "unavailable", never 0 and never
// empty). 403 is `forbidden`; 5xx, timeouts and a route that is not served are `unavailable`, with words the page can show.
//
// The routes are core (`api/:tenantId/requests`), not module routes, so a 404 on a LIST is not "module off": it is a
// backend that does not serve them, which is `unavailable`. A 404 on the DETAIL is the real `request_not_found`: `ok`
// with `null`, and the page calls `notFound()`.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import {
  normalizeRequestDetail, normalizeRequestRow, normalizeSummary, assigneeIdsOf,
  type RequestDetail, type RequestRow, type RequestSummary, type StatusFilter,
} from "./requests";
import type { CreativeAsset } from "./creative";

const base = (t: string) => `/api/${t}/requests`;

export type RequestBox = { box: "mine" } | { box: "sent" | "incoming"; unitId: string };

/** `GET requests?box=&unitId=&status=` (at most 200 rows; `mine` and `sent` newest first, `incoming` oldest first). */
export const readRequests = (u: string, t: string, which: RequestBox, status: StatusFilter): Promise<ReadResult<RequestRow[]>> => {
  const q = new URLSearchParams({ box: which.box, status });
  if (which.box !== "mine") q.set("unitId", which.unitId);
  return readResult(
    platformFetch<unknown>(`${base(t)}?${q.toString()}`, u).then((raw) => {
      // A 200 that is not a list is a broken read, not "no requests".
      if (!Array.isArray(raw)) throw new Error("The requests read returned an unexpected answer.");
      return raw.flatMap((r) => {
        const row = normalizeRequestRow(r);
        return row ? [row] : [];
      });
    }),
  );
};

/** `GET requests/summary?unitId=`: counts or a failure. The caller shows a failure as "unavailable", never 0. */
export const readRequestSummary = (u: string, t: string, unitId: string): Promise<ReadResult<RequestSummary>> =>
  readResult(
    platformFetch<unknown>(`${base(t)}/summary?unitId=${encodeURIComponent(unitId)}`, u).then((raw) => {
      const s = normalizeSummary(raw);
      if (!s) throw new Error("The requests summary returned an unexpected answer.");
      return s;
    }),
  );

/** `GET requests/:id`. `ok` with `null` is a real 404 (`request_not_found`): the page calls `notFound()`. */
export const readRequestDetail = (u: string, t: string, id: string): Promise<ReadResult<RequestDetail | null>> =>
  readResult(
    platformFetch<unknown>(`${base(t)}/${encodeURIComponent(id)}`, u).then((raw): RequestDetail | null => {
      const d = normalizeRequestDetail(raw);
      if (!d) throw new Error("The request read returned an unexpected answer.");
      return d;
    }),
    { absentAsEmpty: null },
  );

/** The people on the work item (`GET pm/tasks/:id`): who may deliver. `ok` with `null` means the task is gone. A failed
 *  read leaves "is this person an assignee" unknown, and the page then does not assume it. */
export const readTaskAssigneeIds = (u: string, t: string, taskId: string): Promise<ReadResult<string[] | null>> =>
  readResult(
    platformFetch<unknown>(`/api/${t}/pm/tasks/${encodeURIComponent(taskId)}`, u).then((raw): string[] => {
      if (!raw || typeof raw !== "object") throw new Error("The task read returned an unexpected answer.");
      return assigneeIdsOf(raw as Parameters<typeof assigneeIdsOf>[0]);
    }),
    { absentAsEmpty: null },
  );

/** The Asset Library, for the Deliver picker. Unlike `listCreativeAssets` (which turns a 404 into []), a route that is
 *  not served is `unavailable` here: an empty picker must mean "the library is empty". */
export const readLibraryAssets = (u: string, t: string): Promise<ReadResult<CreativeAsset[]>> =>
  readResult(
    platformFetch<unknown>(`/api/${t}/creative/assets`, u).then((raw) => {
      if (!Array.isArray(raw)) throw new Error("The Asset Library read returned an unexpected answer.");
      return raw as CreativeAsset[];
    }),
  );
