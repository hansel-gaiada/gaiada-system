import "server-only";
// M5-W5 — the reader and the wire validation for the writers' room calendar and workflow board (server-only half; types, dates and copy
// are in `webdeskCalendarModel.ts`). Same rules as `webdeskEditorial.ts`: EVERY 2xx body is validated before it is returned, a body that
// does not match is `contract_drift` (never rendered as data), and no path turns a refusal into an empty list.
//
//   GET …/editorial/calendar[?from&to&collection&locale&authorSub] -> {tenantSlug, siteId, from, to, truncated, entries[], policies[], counts? | countsWithheld}
//   GET …/briefs/:briefId                                            -> the brief (the page a card's brief link opens)
import { siteBase, wdCall, wire, WireDrift } from "./webdeskContent";
import type { WdResult } from "./webdeskContentModel";
import { REVIEW_STATES, type ReviewState } from "./webdeskEditorialModel";
import {
  PLACEMENT_KINDS, type BriefDetail, type CalendarBody, type CalendarBrief, type CalendarEntry, type CalendarPolicy, type CalendarRequest, type Placement, type PlacementKind,
} from "./webdeskCalendarModel";

const { str, int, bool, nullable, arr, obj, key } = wire;
const strN = nullable(str);
const enc = encodeURIComponent;

function parsePlacement(v: unknown, path: string): Placement {
  const o = obj(v, path);
  const kind = key(o, "kind", str, path);
  if (!(PLACEMENT_KINDS as readonly string[]).includes(kind)) throw new WireDrift(`${path}.kind`, PLACEMENT_KINDS.join("|"), kind);
  return { kind: kind as PlacementKind, at: key(o, "at", str, path) };
}

function parseRequest(v: unknown, path: string): CalendarRequest {
  const o = obj(v, path);
  const command = key(o, "command", str, path);
  if (command !== "content.publish" && command !== "content.schedule") throw new WireDrift(`${path}.command`, "content.publish|content.schedule", command);
  const status = key(o, "status", str, path);
  if (status !== "pending") throw new WireDrift(`${path}.status`, "pending", status);
  return {
    approvalId: key(o, "approvalId", str, path), command, status, publishAt: key(o, "publishAt", strN, path), unpublishAt: key(o, "unpublishAt", strN, path),
    createdAt: key(o, "createdAt", str, path), requestedByMe: key(o, "requestedByMe", bool, path),
  };
}

function parseBrief(v: unknown, path: string): CalendarBrief {
  const o = obj(v, path);
  return { id: key(o, "id", str, path), topic: key(o, "topic", str, path), status: key(o, "status", str, path), assigneeId: key(o, "assigneeId", strN, path) };
}

function parseEntry(v: unknown, path: string): CalendarEntry {
  const o = obj(v, path);
  const intN = nullable(int);
  return {
    itemId: key(o, "itemId", str, path), collectionKey: key(o, "collectionKey", str, path), locale: key(o, "locale", str, path), slug: key(o, "slug", str, path),
    title: key(o, "title", strN, path), headVersion: key(o, "headVersion", int, path), publishState: key(o, "publishState", str, path),
    publishAt: key(o, "publishAt", strN, path), unpublishAt: key(o, "unpublishAt", strN, path),
    reviewState: key(o, "reviewState", str, path), reviewRequired: key(o, "reviewRequired", bool, path), inFlow: key(o, "inFlow", bool, path),
    authorSub: key(o, "authorSub", strN, path), dueAt: key(o, "dueAt", strN, path), plannedPublishAt: key(o, "plannedPublishAt", strN, path),
    submittedVersion: key(o, "submittedVersion", intN, path), approvedVersion: key(o, "approvedVersion", intN, path), openComments: key(o, "openComments", int, path),
    briefRef: key(o, "briefRef", strN, path), brief: key(o, "brief", nullable(parseBrief), path), briefHidden: key(o, "briefHidden", bool, path),
    requests: key(o, "requests", arr(parseRequest), path), placement: key(o, "placement", nullable(parsePlacement), path),
  };
}

function parsePolicy(v: unknown, path: string): CalendarPolicy {
  const o = obj(v, path);
  return { collectionKey: key(o, "collectionKey", str, path), reviewRequired: key(o, "reviewRequired", bool, path), seoSignoffRequired: key(o, "seoSignoffRequired", bool, path) };
}

/** `counts` and `countsWithheld` are two halves of ONE fact, as on the board: both, or neither, is drift. Withheld counts are `null`, never zeros. */
export function parseCalendar(v: unknown): CalendarBody {
  const p = "calendar";
  const o = obj(v, p);
  const withheld = o.countsWithheld === true;
  let counts: Record<ReviewState, number> | null = null;
  if (withheld) {
    if ("counts" in o && o.counts !== undefined) throw new WireDrift(`${p}.counts`, "absent (countsWithheld is true)", o.counts);
  } else {
    if ("countsWithheld" in o && o.countsWithheld !== undefined && o.countsWithheld !== false) throw new WireDrift(`${p}.countsWithheld`, "true or absent", o.countsWithheld);
    const c = obj(key(o, "counts", obj, p), `${p}.counts`);
    counts = { draft: 0, in_review: 0, changes_requested: 0, approved: 0 };
    for (const s of REVIEW_STATES) counts[s] = key(c, s, int, `${p}.counts`);
  }
  return {
    tenantSlug: key(o, "tenantSlug", str, p), siteId: key(o, "siteId", str, p), from: key(o, "from", strN, p), to: key(o, "to", strN, p),
    truncated: key(o, "truncated", bool, p), entries: key(o, "entries", arr(parseEntry), p), policies: key(o, "policies", arr(parsePolicy), p),
    counts, countsWithheld: withheld,
  };
}

export function parseBriefDetail(v: unknown): BriefDetail {
  const p = "brief";
  const o = obj(v, p);
  return {
    id: key(o, "id", str, p), status: key(o, "status", str, p), topic: key(o, "topic", str, p), targetQuery: key(o, "targetQuery", strN, p), searchIntent: key(o, "searchIntent", strN, p),
    aiQuestions: key(o, "aiQuestions", arr(str), p), contentGaps: key(o, "contentGaps", arr(str), p), outline: key(o, "outline", arr(str), p), body: key(o, "body", str, p),
    geoNotes: key(o, "geoNotes", strN, p), collectionKey: key(o, "collectionKey", strN, p), locale: key(o, "locale", strN, p), itemId: key(o, "itemId", strN, p),
    assigneeId: key(o, "assigneeId", strN, p), updatedAt: key(o, "updatedAt", str, p),
  };
}

export interface CalendarQuery { from?: string; to?: string; collection?: string; locale?: string; authorSub?: string }

export function getEditorialCalendar(userId: string, company: string, tenantSlug: string, siteId: string, q: CalendarQuery = {}): Promise<WdResult<CalendarBody>> {
  const p = new URLSearchParams();
  if (q.from && q.to) { p.set("from", q.from); p.set("to", q.to); }
  if (q.collection) p.set("collection", q.collection);
  if (q.locale) p.set("locale", q.locale);
  if (q.authorSub) p.set("authorSub", q.authorSub);
  const qs = p.toString();
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/editorial/calendar${qs ? `?${qs}` : ""}`, userId, parseCalendar);
}

export function getBrief(userId: string, company: string, tenantSlug: string, siteId: string, briefId: string): Promise<WdResult<BriefDetail>> {
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/briefs/${enc(briefId)}`, userId, parseBriefDetail);
}
