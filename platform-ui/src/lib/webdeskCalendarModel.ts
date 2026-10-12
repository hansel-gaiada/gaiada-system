// M5-W5 — the editorial calendar and workflow board, client-safe half: types, the placement vocabulary, the pure date and grouping rules,
// and every refusal in plain words. NO `server-only`, NO I/O. The reader and the parser are `webdeskCalendar.ts` (server-only).
//
//   BFF (FRONTEND-BFF-CONTRACT §27 "Writers' room calendar"): GET …/sites/:tenantSlug/:siteId/editorial/calendar[?from&to&collection&locale&authorSub]
//
// ONE DATE PER ITEM, and the BFF says which (`placement.kind`): the item's own `publish_at`, else the earliest requested publish time of a
// pending request, else the author's planned publish date, else its due date. An item with none of them is UNSCHEDULED. Days are UTC days.
// Nothing here decides what a caller may do: the board and the calendar offer links, not actions.
import type { Page, WdResult } from "./webdeskContentModel";
import type { BoardItem, EditorialBoard, ReviewState } from "./webdeskEditorialModel";
import { REVIEW_STATES, isReviewState } from "./webdeskEditorialModel";

// ── the wire shape ───────────────────────────────────────────────────────────────────────────────

export const PLACEMENT_KINDS = ["publish_at", "requested_publish", "planned", "due"] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];
export interface Placement { kind: PlacementKind; at: string }

export interface CalendarRequest {
  approvalId: string;
  command: "content.publish" | "content.schedule";
  status: "pending";
  publishAt: string | null;
  unpublishAt: string | null;
  createdAt: string;
  /** The CALLER filed it. The filer is never named. */
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
  /** In WebDesk's review flow (on the workflow board). A scheduled item of a review-off collection is on the calendar only. */
  inFlow: boolean;
  authorSub: string | null;
  dueAt: string | null;
  plannedPublishAt: string | null;
  submittedVersion: number | null;
  approvedVersion: number | null;
  openComments: number;
  briefRef: string | null;
  /** Only when the caller may read the brief. */
  brief: CalendarBrief | null;
  /** A brief is linked and the caller may not read it. */
  briefHidden: boolean;
  requests: CalendarRequest[];
  placement: Placement | null;
}

export interface CalendarPolicy { collectionKey: string; reviewRequired: boolean; seoSignoffRequired: boolean }

export interface CalendarBody {
  tenantSlug: string;
  siteId: string;
  from: string | null;
  to: string | null;
  /** A cap cut a read: rows may be missing. Said in words, never ignored. */
  truncated: boolean;
  entries: CalendarEntry[];
  policies: CalendarPolicy[];
  /** Whole-site per-state counts; null exactly when `countsWithheld`. Never read a withheld count as zero. */
  counts: Record<ReviewState, number> | null;
  countsWithheld: boolean;
}

/** The brief (`GET …/briefs/:briefId`), the fields the brief page draws. */
export interface BriefDetail {
  id: string;
  status: string;
  topic: string;
  targetQuery: string | null;
  searchIntent: string | null;
  aiQuestions: string[];
  contentGaps: string[];
  outline: string[];
  body: string;
  geoNotes: string | null;
  collectionKey: string | null;
  locale: string | null;
  itemId: string | null;
  assigneeId: string | null;
  updatedAt: string;
}

// ── placement vocabulary ─────────────────────────────────────────────────────────────────────────

export interface PlacementInfo { label: string; sentence: string; glyph: string }

export function placementInfo(kind: PlacementKind): PlacementInfo {
  switch (kind) {
    case "publish_at": return { label: "Publishes", sentence: "The date this item goes live (or went live).", glyph: "▶" };
    case "requested_publish": return { label: "Publish requested for", sentence: "A publish request for this day is waiting for approval.", glyph: "◆" };
    case "planned": return { label: "Planned for", sentence: "The day the author or editor planned to publish.", glyph: "◇" };
    case "due": return { label: "Due", sentence: "The day the draft is due.", glyph: "●" };
  }
}

/** The legend: every kind, in the order the rule prefers them. */
export const PLACEMENT_LEGEND: ReadonlyArray<{ kind: PlacementKind } & PlacementInfo> = PLACEMENT_KINDS.map((kind) => ({ kind, ...placementInfo(kind) }));

// ── UTC days ─────────────────────────────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: string): boolean => {
  if (!DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const ms = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const dayOfMs = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dayOfMs(ms(day) + n * 86_400_000);
/** The UTC day an instant falls on. */
export const dayOf = (iso: string): string => new Date(iso).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday. */
const weekdayMon = (day: string): number => (new Date(ms(day)).getUTCDay() + 6) % 7;
export const mondayOf = (day: string): string => addDays(day, -weekdayMon(day));
export const firstOfMonth = (day: string): string => `${day.slice(0, 7)}-01`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const monthLabel = (day: string): string => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
/** "12 Oct" for a UTC day. */
export const shortDay = (day: string): string => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3)}`;

export type CalendarViewKind = "month" | "week";
export const isViewKind = (s: string | undefined): s is CalendarViewKind => s === "month" || s === "week";

export interface CalendarGrid {
  view: CalendarViewKind;
  /** The anchor day (any day inside the shown month or week). */
  anchor: string;
  title: string;
  /** The window to ask the BFF for: the first and last cell. */
  from: string;
  to: string;
  /** Rows of seven days, Monday first. A week has one row. */
  weeks: string[][];
  /** The month a cell belongs to (month view dims the others). */
  month: string;
  prev: string;
  next: string;
}

/** The grid for a view and anchor. A month grid runs whole weeks (4 to 6 rows), so its window is at most 42 days. */
export function gridFor(view: CalendarViewKind, anchor: string): CalendarGrid {
  if (view === "week") {
    const from = mondayOf(anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    return { view, anchor, title: `${shortDay(days[0])} – ${shortDay(days[6])} ${days[6].slice(0, 4)}`, from, to: days[6], weeks: [days], month: anchor.slice(0, 7), prev: addDays(anchor, -7), next: addDays(anchor, 7) };
  }
  const first = firstOfMonth(anchor);
  const start = mondayOf(first);
  const nextMonth = addDays(first, 31).slice(0, 7) + "-01";
  const last = addDays(nextMonth, -1);
  const end = addDays(mondayOf(last), 6);
  const weeks: string[][] = [];
  for (let d = start; d <= end; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return { view, anchor, title: monthLabel(first), from: start, to: end, weeks, month: first.slice(0, 7), prev: addDays(first, -1).slice(0, 7) + "-01", next: nextMonth };
}

/** A usable anchor: the URL's `day` when it is a real day, else today. A bad value is ignored, never an error page. */
export const anchorFrom = (day: string | undefined, today: string): string => (day !== undefined && isDay(day) ? day : today);

// ── placing entries ──────────────────────────────────────────────────────────────────────────────

/** Entries by the UTC day of their placement. Each day's list is in time order, then by collection and slug. Unplaced entries are not here. */
export function bucketByDay(entries: readonly CalendarEntry[]): Map<string, CalendarEntry[]> {
  const out = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    if (!e.placement) continue;
    const day = dayOf(e.placement.at);
    const list = out.get(day) ?? [];
    list.push(e);
    out.set(day, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.placement!.at < b.placement!.at ? -1 : a.placement!.at > b.placement!.at ? 1 : a.collectionKey.localeCompare(b.collectionKey) || a.slug.localeCompare(b.slug) || a.locale.localeCompare(b.locale)));
  return out;
}

/** Items with no date of any kind that are still waiting to be scheduled (a live item with no date is not one; the BFF leaves it out). */
export const unscheduled = (entries: readonly CalendarEntry[]): CalendarEntry[] => entries.filter((e) => e.placement === null);

/** Placed entries that fall outside the shown grid (the BFF filters to the window, so this is a drift check the page reports, never hides). */
export const outsideGrid = (entries: readonly CalendarEntry[], from: string, to: string): CalendarEntry[] =>
  entries.filter((e) => e.placement !== null && (dayOf(e.placement.at) < from || dayOf(e.placement.at) > to));

/** The other dates an entry carries, as words, when they are not the one it is placed on ("Due 10 Oct", "Planned for 12 Oct"). */
export function otherDates(e: CalendarEntry): string[] {
  const out: string[] = [];
  const placed = e.placement?.kind;
  if (e.publishAt && placed !== "publish_at" && (e.publishState === "scheduled" || e.publishState === "published")) out.push(`${placementInfo("publish_at").label} ${shortDay(dayOf(e.publishAt))}`);
  if (e.plannedPublishAt && placed !== "planned") out.push(`${placementInfo("planned").label} ${shortDay(dayOf(e.plannedPublishAt))}`);
  if (e.dueAt && placed !== "due") out.push(`${placementInfo("due").label} ${shortDay(dayOf(e.dueAt))}`);
  return out;
}

/** "Publish requested", with the day when the request names one; whether it is yours. null when nothing is pending. */
export function requestBadge(requests: readonly CalendarRequest[]): string | null {
  if (requests.length === 0) return null;
  const timed = requests.map((r) => r.publishAt).filter((x): x is string => x !== null).sort()[0];
  const mine = requests.some((r) => r.requestedByMe);
  const what = requests.length > 1 ? `${requests.length} publish requests pending` : "Publish request pending";
  return `${what}${timed ? ` for ${shortDay(dayOf(timed))}` : ""}${mine ? " (yours)" : ""}`;
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────────

export interface CalendarFilters { collection?: string; locale?: string; assignee?: "me" }

/** The BFF query for a filter set: "me" becomes the caller's own id. */
export function queryFor(f: CalendarFilters, me: string, window?: { from: string; to: string }): { from?: string; to?: string; collection?: string; locale?: string; authorSub?: string } {
  return {
    ...(window ? { from: window.from, to: window.to } : {}),
    ...(f.collection ? { collection: f.collection } : {}),
    ...(f.locale ? { locale: f.locale } : {}),
    ...(f.assignee === "me" ? { authorSub: me } : {}),
  };
}

export const filtersFrom = (sp: { collection?: string; locale?: string; assignee?: string }): CalendarFilters => ({
  ...(sp.collection ? { collection: sp.collection } : {}),
  ...(sp.locale ? { locale: sp.locale } : {}),
  ...(sp.assignee === "me" ? { assignee: "me" as const } : {}),
});

/** Every collection and locale worth offering: the BFF's rows, the policies, and the site's own locales. */
export function filterChoices(body: CalendarBody, siteLocales: readonly string[]): { collections: string[]; locales: string[] } {
  return {
    collections: Array.from(new Set([...body.policies.map((p) => p.collectionKey), ...body.entries.map((e) => e.collectionKey)])).sort(),
    locales: Array.from(new Set([...siteLocales, ...body.entries.map((e) => e.locale)])).sort(),
  };
}

// ── the workflow board, from the same read ───────────────────────────────────────────────────────

/** A board card: WritersBoard's `BoardItem` plus what the calendar read adds (brief, pending requests, the placement). */
export interface WorkflowCard extends BoardItem {
  brief: CalendarBrief | null;
  briefHidden: boolean;
  briefRef: string | null;
  requests: CalendarRequest[];
  placement: Placement | null;
}

export interface WorkflowBoard extends Omit<EditorialBoard, "items"> {
  items: WorkflowCard[];
  truncated: boolean;
}

/** The board is the entries WebDesk lists in the review flow (`inFlow`); a scheduled item of a review-off collection is calendar-only. */
export function toWorkflowBoard(body: CalendarBody, state?: string): WorkflowBoard {
  const items: WorkflowCard[] = body.entries
    .filter((e) => e.inFlow && (!state || e.reviewState === state))
    .map((e) => ({
      itemId: e.itemId, collectionKey: e.collectionKey, locale: e.locale, slug: e.slug, title: e.title, headVersion: e.headVersion, publishState: e.publishState,
      editorial: {
        reviewRequired: e.reviewRequired, state: e.reviewState, approvedVersion: e.approvedVersion, authorSub: e.authorSub, submittedVersion: e.submittedVersion,
        dueAt: e.dueAt, plannedPublishAt: e.plannedPublishAt, briefRef: e.briefRef, openComments: e.openComments,
      },
      brief: e.brief, briefHidden: e.briefHidden, briefRef: e.briefRef, requests: e.requests, placement: e.placement,
    }));
  return { items, counts: body.counts, countsWithheld: body.countsWithheld, policies: body.policies, page: { cursor: null, hasMore: false, limit: items.length } satisfies Page, truncated: body.truncated };
}

export const isKnownReviewState = isReviewState;
export { REVIEW_STATES };

// ── refusals in words ────────────────────────────────────────────────────────────────────────────

const PART_WORDS: Record<string, string> = {
  board_unreadable: "the review board",
  scheduled_unreadable: "the scheduled publish dates",
  requests_unreadable: "the pending publish requests",
  briefs_unreadable: "the briefs",
  authorization_unreadable: "your permissions",
};

/** When a failed read is the BFF's "this part could not be read", the sentence for it; otherwise null (the generic refusal handles it). */
export function partFailureWords(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string | null {
  if (r.kind !== "unavailable" || r.code !== "editorial_unavailable") return null;
  const part = PART_WORDS[r.reason];
  if (!part) return null;
  return `The calendar couldn't read ${part}. Nothing is shown rather than a calendar that may be missing items. Nothing has been lost; try again.`;
}

export const TRUNCATED_WORDS = "This list was cut short: the site has more items than one read returns, so some are missing. Narrow it with a collection or language filter.";
export const COUNTS_WITHHELD_WORDS = "Counts are hidden for your access. The site-wide totals would include items you aren't allowed to see, so they aren't shown.";
export const UTC_NOTE = "Days are UTC days.";
