import "server-only";
// DW-5c UI: readers behind /requests, /requests/new, /requests/[id] and the Sent tab (docs/FRONTEND-BFF-CONTRACT.md
// §32.5). Every reader returns a `ReadResult`: a refusal or a failed read is DATA the page renders with <ReadRefusal>,
// never an empty list that reads as "no requests" (plan trap 4: a failed read says "unavailable", never 0 and never
// empty). 403 is `forbidden`; 5xx, timeouts and a route that is not served are `unavailable`, with words the page can show.
//
// The routes are core (`api/:tenantId/requests`), not module routes, so a 404 on a LIST is not "module off": it is a
// backend that does not serve them, which is `unavailable`. A 404 on the DETAIL is the real `request_not_found`: `ok`
// with `null`, and the page calls `notFound()`.
import { cache } from "react";
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import {
  isOutboundScope, normalizeOutboundFiles, normalizeOutboundSummary, normalizeRequestDetail, normalizeRequestRow, normalizeRoutes, normalizeSummary, assigneeIdsOf,
  type OutboundFile, type OutboundScope, type OutboundSummary, type RequestDetail, type RequestKind, type RequestRoute, type RequestRow,
  type RequestSummary, type RoutesRead, type StatusFilter,
} from "./requests";
import type { CreativeAsset } from "./creative";

const base = (t: string) => `/api/${t}/requests`;

export type RequestBox = { box: "mine" } | { box: "sent" | "incoming"; unitId: string };

/** `GET requests?box=&unitId=&status=` (at most 200 rows; `mine` and `sent` newest first, `incoming` oldest first). */
export const readRequests = (
  u: string, t: string, which: RequestBox, status: StatusFilter, opts: { kind?: RequestKind } = {},
): Promise<ReadResult<RequestRow[]>> => {
  const q = new URLSearchParams({ box: which.box, status });
  if (which.box !== "mine") q.set("unitId", which.unitId);
  if (opts.kind) q.set("kind", opts.kind);
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

// ── DW-10e: requests across group companies (BFF §60.5) ─────────────────────────────────────────────────────────────────────────────
// Every sender route runs under the ASKING company's id (the active company), never the receiver's. They are core routes like §32's, so a
// 404 on a list is a backend that does not serve them (`unavailable`), and a 404 on one request is the real `request_not_found`.
const outboundBase = (t: string) => `/api/${t}/requests/outbound`;

/** `GET requests/routes`: the active routes of the company, or why they could not be read. `ok` with `enabled: false` is the switch being
 *  off, which is an answer. */
export const readRequestRoutes = (u: string, t: string): Promise<ReadResult<RoutesRead>> =>
  readResult(
    platformFetch<unknown>(`${base(t)}/routes`, u).then((raw) => {
      const r = normalizeRoutes(raw);
      if (!r) throw new Error("The routes read returned an unexpected answer.");
      return r;
    }),
  );

/** The routes as the shell and the Overview gates read them (`GateContext.routes`): the list, or null when the read failed (which
 *  hides, like an unknown one). Memoised per request, so the layout and a page share one read (BFF §60.9). Never throws. */
export const routesForShell = cache(async function routesForShell(u: string, t: string | null): Promise<RequestRoute[] | null> {
  if (!t) return null;
  const r = await readRequestRoutes(u, t);
  return r.kind === "ok" ? r.data.routes : null;
});

export type OutboundBox = { box: "mine" } | { box: "sent"; unitId: string };
export interface OutboundList { scope: OutboundScope; rows: RequestRow[] }

/** `GET requests/outbound?box=&unitId=&status=` (at most 200 rows, newest first). `scope` says whether the rows are everything the
 *  company sent (`company`), what the departments the caller leads sent plus their own (`unit`, DW-D43), or only the caller's (`own`,
 *  DW-D40): the page says which, never leaving it to be assumed. */
export const readOutboundRequests = (
  u: string, t: string, which: OutboundBox, status: StatusFilter, opts: { kind?: RequestKind } = {},
): Promise<ReadResult<OutboundList>> => {
  const q = new URLSearchParams({ box: which.box, status });
  if (which.box === "sent") q.set("unitId", which.unitId);
  if (opts.kind) q.set("kind", opts.kind);
  return readResult(
    platformFetch<unknown>(`${outboundBase(t)}?${q.toString()}`, u).then((raw) => {
      const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      // A 200 without a scope or a row list is a broken read, not "you sent nothing".
      if (!o || !isOutboundScope(o.scope) || !Array.isArray(o.rows)) throw new Error("The sent-requests read returned an unexpected answer.");
      const rows = o.rows.flatMap((r) => {
        const row = normalizeRequestRow(r, { outbound: true });
        return row ? [row] : [];
      });
      return { scope: o.scope, rows };
    }),
  );
};

/** `GET requests/outbound/summary?unitId=`: open requests the department's company sent to others, or a failure (never 0). */
export const readOutboundSummary = (u: string, t: string, unitId: string): Promise<ReadResult<OutboundSummary>> =>
  readResult(
    platformFetch<unknown>(`${outboundBase(t)}/summary?unitId=${encodeURIComponent(unitId)}`, u).then((raw) => {
      const s = normalizeOutboundSummary(raw);
      if (!s) throw new Error("The sent-requests summary returned an unexpected answer.");
      return s;
    }),
  );

/** `GET requests/outbound/:id`. `ok` with `null` is a real 404 (`request_not_found`: absent, or another person's while the caller may not read
 *  the company's): the page calls `notFound()`. */
export const readOutboundDetail = (u: string, t: string, id: string): Promise<ReadResult<RequestDetail | null>> =>
  readResult(
    platformFetch<unknown>(`${outboundBase(t)}/${encodeURIComponent(id)}`, u).then((raw): RequestDetail | null => {
      const d = normalizeRequestDetail(raw, { outbound: true });
      if (!d) throw new Error("The request read returned an unexpected answer.");
      return d;
    }),
    { absentAsEmpty: null },
  );

/** `GET requests/outbound/:id/files`: the request's files, read-only. A failed read is data, so the page can say the files could not be listed. */
export const readOutboundFiles = (u: string, t: string, id: string): Promise<ReadResult<OutboundFile[]>> =>
  readResult(
    platformFetch<unknown>(`${outboundBase(t)}/${encodeURIComponent(id)}/files`, u).then((raw) => {
      const f = normalizeOutboundFiles(raw);
      if (!f) throw new Error("The files read returned an unexpected answer.");
      return f;
    }),
  );
