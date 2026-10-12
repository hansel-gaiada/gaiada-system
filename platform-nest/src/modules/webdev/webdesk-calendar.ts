// M5-W5 — the pure half of the editorial calendar read (docs/plans/2026-10-11-m5-writers-room-design.md §5, W5): the query parser, the
// placement rule (which date an item sits on), the range rule, the join of WebDesk's rows, and the typed 503 that names the part that
// could not be read. No I/O, no Cerbos, no clock: `webdesk-calendar.service.ts` does those and calls these. FRONTEND-BFF-CONTRACT §27
// "Writers' room calendar".
//
// THE PLACEMENT RULE (one date per item, and the answer says which): publish_at (a scheduled or published item's own date) >
// the earliest requested publish time of a PENDING publish/schedule request > the author's planned publish date > the due date.
// An item with none of the four is UNSCHEDULED; a published one is not listed as such (nothing is waiting to be scheduled).
// Days are UTC days; the answer carries instants and the UI says so in words.
import { BadRequestException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { UUID_RE, isPlainObject } from "./webdesk-content.service";

const logger = new Logger("WebdeskCalendar");

export const BOARD_PAGE_LIMIT = 100;
/** At most this many board pages are followed (2000 items). Past it the answer says `truncated: true`, never a quiet cut. */
export const MAX_BOARD_PAGES = 20;
/** Scheduled items are read one page of this size per collection; a fuller page says `truncated: true`. */
export const SCHEDULED_PAGE_LIMIT = 100;
/** The longest window one call answers (a six-week month grid is 42 days). */
export const MAX_SPAN_DAYS = 100;
/** Cerbos refuses a CheckResources request with more than 50 resources. This module asks one resource per request and never batches. */
export const CERBOS_BATCH_MAX = 50;

// ── the 503 that names its part ──────────────────────────────────────────────────────────────────

export type CalendarPart = "board" | "scheduled" | "briefs" | "requests" | "authorization";

/** `{message:"calendar_unavailable", reason:"board_unreadable", part:"board"}`. The UI reads `reason`, as for every 503 of §27. */
export function calendarUnavailable(part: CalendarPart, cause?: string): ServiceUnavailableException {
  return new ServiceUnavailableException({ message: "calendar_unavailable", reason: `${part}_unreadable`, part, ...(cause ? { cause } : {}) });
}

/**
 * Runs one upstream read. ANY failure of it (WebDesk down, a typed WebDesk problem, a database error) becomes the 503 that names the
 * part: the caller never gets a list built from the parts that did answer. The log line carries the part and the error class only.
 */
export async function readPart<T>(part: CalendarPart, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    logger.warn(`calendar part ${part} could not be read (${name})`);
    const response = (err as { response?: unknown } | null)?.response;
    const cause = isPlainObject(response) && typeof response.reason === "string" ? response.reason : undefined;
    throw calendarUnavailable(part, cause);
  }
}

// ── query ────────────────────────────────────────────────────────────────────────────────────────

export interface CalendarQuery {
  /** Both or neither. UTC days, inclusive. */
  from?: string;
  to?: string;
  collection?: string;
  locale?: string;
  authorSub?: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function bad(detail: string): BadRequestException {
  return new BadRequestException({ message: `invalid_request: ${detail}`, reason: "invalid_request" });
}

/** A real calendar day (2026-02-30 is not one). Returns the UTC midnight in ms. */
export function dayStart(day: string): number {
  if (!DAY_RE.test(day)) throw bad(`${day} is not a YYYY-MM-DD date`);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) throw bad(`${day} is not a real date`);
  return ms;
}

const ALLOWED_QUERY = ["from", "to", "collection", "locale", "authorSub"] as const;

export function parseCalendarQuery(raw: unknown): CalendarQuery {
  const q = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(q)) throw bad("the query must be an object");
  for (const k of Object.keys(q)) if (!(ALLOWED_QUERY as readonly string[]).includes(k)) throw bad(`unknown query parameter ${k}`);
  const str = (k: (typeof ALLOWED_QUERY)[number], max: number): string | undefined => {
    const v = q[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length === 0 || v.length > max) throw bad(`${k} must be a non-empty string of at most ${max} characters`);
    return v;
  };
  const from = str("from", 10);
  const to = str("to", 10);
  if ((from === undefined) !== (to === undefined)) throw bad("from and to are given together, or not at all");
  if (from !== undefined && to !== undefined) {
    const a = dayStart(from);
    const b = dayStart(to);
    if (b < a) throw bad("to must not be before from");
    if ((b - a) / DAY_MS + 1 > MAX_SPAN_DAYS) throw bad(`the window is at most ${MAX_SPAN_DAYS} days`);
  }
  const authorSub = str("authorSub", 64);
  if (authorSub !== undefined && !UUID_RE.test(authorSub)) throw bad("authorSub must be a user id (uuid)");
  const out: CalendarQuery = {};
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  const collection = str("collection", 128);
  if (collection !== undefined) out.collection = collection;
  const locale = str("locale", 35);
  if (locale !== undefined) out.locale = locale;
  if (authorSub !== undefined) out.authorSub = authorSub.toLowerCase();
  return out;
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────────

export type PlacementKind = "publish_at" | "requested_publish" | "planned" | "due";

export interface Placement { kind: PlacementKind; at: string }

export interface CalendarRequest {
  approvalId: string;
  /** `content.publish` (no time) or `content.schedule`. */
  command: "content.publish" | "content.schedule";
  status: "pending";
  publishAt: string | null;
  unpublishAt: string | null;
  createdAt: string;
  /** Whether the CALLER filed it. The filer's identity is never sent. */
  requestedByMe: boolean;
}

export interface CalendarBrief { id: string; topic: string; status: string; assigneeId: string | null }

export interface CalendarEntry {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  title: string | null;
  headVersion: number;
  publishState: string;
  publishAt: string | null;
  unpublishAt: string | null;
  reviewState: string;
  reviewRequired: boolean;
  /** In WebDesk's review flow (the board lists it). A scheduled item of a review-off collection is on the calendar but not on the board. */
  inFlow: boolean;
  authorSub: string | null;
  dueAt: string | null;
  plannedPublishAt: string | null;
  submittedVersion: number | null;
  approvedVersion: number | null;
  openComments: number;
  briefRef: string | null;
  /** Present only when the caller may read the brief (Cerbos, as for `GET …/briefs`). */
  brief: CalendarBrief | null;
  /** A brief is linked and the caller may not read it: said in words, never silently dropped. */
  briefHidden: boolean;
  requests: CalendarRequest[];
  placement: Placement | null;
}

/** What the merge keeps of one WebDesk row (a board row or a scheduled `item.list` row). */
export interface SourceRow {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  title: string | null;
  headVersion: number;
  publishState: string;
  publishAt: string | null;
  unpublishAt: string | null;
  editorial: Record<string, unknown> | null;
  /** The row came from WebDesk's review board (the item is in the review flow), not only from the scheduled list. */
  inFlow: boolean;
}

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const instant = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** A row of WebDesk's answer, or null when it is not the shape (a malformed row is dropped from the merge and counted by the caller). */
export function parseSourceRow(v: unknown, inFlow: boolean, collectionHint?: string): SourceRow | null {
  if (!isPlainObject(v)) return null;
  const itemId = s(v.itemId);
  const collectionKey = s(v.collectionKey) ?? collectionHint ?? null;
  const locale = s(v.locale);
  const slug = s(v.slug);
  const headVersion = n(v.headVersion);
  if (!itemId || !collectionKey || !locale || !slug || headVersion === null) return null;
  return {
    itemId, collectionKey, locale, slug, title: s(v.title), headVersion,
    publishState: s(v.publishState) ?? "draft",
    publishAt: instant(v.publishAt), unpublishAt: instant(v.unpublishAt),
    editorial: isPlainObject(v.editorial) ? v.editorial : null,
    inFlow,
  };
}

/**
 * The join of the two WebDesk reads, by item id. A board row carries the review record; a scheduled row adds `publishAt` and covers
 * items the board never lists (a review-off collection). Where both exist the board's editorial wins and the scheduled row's dates fill in.
 */
export function mergeRows(board: readonly SourceRow[], scheduled: readonly SourceRow[]): SourceRow[] {
  const byId = new Map<string, SourceRow>();
  for (const r of board) byId.set(r.itemId, r);
  for (const r of scheduled) {
    const had = byId.get(r.itemId);
    if (!had) {
      byId.set(r.itemId, r);
      continue;
    }
    byId.set(r.itemId, { ...had, inFlow: had.inFlow || r.inFlow, publishAt: r.publishAt ?? had.publishAt, unpublishAt: r.unpublishAt ?? had.unpublishAt, publishState: r.publishState || had.publishState });
  }
  return [...byId.values()];
}

/** The earliest requested publish time among PENDING requests, or null (a publish request with no time is "as soon as approved": no date). */
export function earliestRequested(requests: readonly CalendarRequest[]): string | null {
  let best: string | null = null;
  for (const r of requests) if (r.status === "pending" && r.publishAt && (best === null || r.publishAt < best)) best = r.publishAt;
  return best;
}

export function placementOf(e: { publishState: string; publishAt: string | null; plannedPublishAt: string | null; dueAt: string | null; requests: readonly CalendarRequest[] }): Placement | null {
  if (e.publishAt && (e.publishState === "scheduled" || e.publishState === "published")) return { kind: "publish_at", at: e.publishAt };
  const req = earliestRequested(e.requests);
  if (req) return { kind: "requested_publish", at: req };
  if (e.plannedPublishAt) return { kind: "planned", at: e.plannedPublishAt };
  if (e.dueAt) return { kind: "due", at: e.dueAt };
  return null;
}

/** Is `at` inside the window? `from` and `to` are UTC days, both inclusive. */
export function inWindow(at: string, from: string, to: string): boolean {
  const t = Date.parse(at);
  return !Number.isNaN(t) && t >= dayStart(from) && t < dayStart(to) + DAY_MS;
}

/** The window rule: a placed item is listed when its date is inside; an unplaced one when nothing is waiting to schedule it only if it is not live. */
export function inCalendar(e: { placement: Placement | null; publishState: string }, win: { from: string; to: string } | null): boolean {
  if (win === null) return true;
  if (e.placement === null) return e.publishState !== "published";
  return inWindow(e.placement.at, win.from, win.to);
}

export function matchesFilters(r: { collectionKey: string; locale: string; editorial: Record<string, unknown> | null }, q: CalendarQuery): boolean {
  if (q.collection !== undefined && r.collectionKey !== q.collection) return false;
  if (q.locale !== undefined && r.locale !== q.locale) return false;
  if (q.authorSub !== undefined) {
    const a = s(r.editorial?.authorSub);
    if (a === null || a.toLowerCase() !== q.authorSub) return false;
  }
  return true;
}

/** Builds the entry from a row once its requests and brief are known. `requests` are this item's pending requests. */
export function entryOf(r: SourceRow, requests: CalendarRequest[], brief: CalendarBrief | null, briefHidden: boolean): CalendarEntry {
  const e = r.editorial ?? {};
  const base = {
    publishState: r.publishState,
    publishAt: r.publishAt,
    plannedPublishAt: instant(e.plannedPublishAt),
    dueAt: instant(e.dueAt),
    requests,
  };
  return {
    itemId: r.itemId, collectionKey: r.collectionKey, locale: r.locale, slug: r.slug, title: r.title, headVersion: r.headVersion,
    publishState: r.publishState, publishAt: r.publishAt, unpublishAt: r.unpublishAt,
    reviewState: s(e.state) ?? "draft", reviewRequired: e.reviewRequired === true, inFlow: r.inFlow,
    authorSub: s(e.authorSub), dueAt: base.dueAt, plannedPublishAt: base.plannedPublishAt,
    submittedVersion: n(e.submittedVersion), approvedVersion: n(e.approvedVersion), openComments: n(e.openComments) ?? 0,
    briefRef: s(e.briefRef), brief, briefHidden, requests,
    placement: placementOf(base),
  };
}

/** Oldest placement first; the unscheduled last; ties by collection, slug, locale (a stable order the UI can rely on). */
export function sortEntries(list: CalendarEntry[]): CalendarEntry[] {
  return [...list].sort((a, b) => {
    const pa = a.placement?.at ?? "9999";
    const pb = b.placement?.at ?? "9999";
    return pa < pb ? -1 : pa > pb ? 1 : a.collectionKey.localeCompare(b.collectionKey) || a.slug.localeCompare(b.slug) || a.locale.localeCompare(b.locale);
  });
}

// ── the pending requests (WS4 approvals, origin webdesk) ─────────────────────────────────────────

export interface RequestRow { id: string; created_at: Date | string; requested_by: string | null; workflow_id: string; tool_args: Record<string, unknown> | null }

/**
 * `automation_approvals.tool_args` of a `content.publish` / `content.schedule` row, as `listOwnPublishRequests` reads it:
 * `items:[{itemId,version}]`, and for a schedule `publishAt` / `unpublishAt`. Returns request by item id. A row whose args do not parse
 * is skipped (it names no item the calendar could attach it to).
 */
export function requestsByItem(rows: readonly RequestRow[], me: string | null): Map<string, CalendarRequest[]> {
  const out = new Map<string, CalendarRequest[]>();
  for (const r of rows) {
    const a = r.tool_args;
    if (!a || !Array.isArray(a.items)) continue;
    const command = r.workflow_id === "content.schedule" ? "content.schedule" : r.workflow_id === "content.publish" ? "content.publish" : null;
    if (command === null) continue;
    const req: CalendarRequest = {
      approvalId: r.id, command, status: "pending",
      publishAt: instant(a.publishAt), unpublishAt: instant(a.unpublishAt),
      createdAt: new Date(r.created_at).toISOString(),
      requestedByMe: me !== null && r.requested_by === me,
    };
    for (const i of a.items) {
      if (!isPlainObject(i) || typeof i.itemId !== "string") continue;
      const id = i.itemId.toLowerCase();
      const list = out.get(id) ?? [];
      list.push(req);
      out.set(id, list);
    }
  }
  for (const list of out.values()) list.sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.approvalId.localeCompare(y.approvalId)));
  return out;
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
