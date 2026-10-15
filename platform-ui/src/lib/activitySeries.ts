import "server-only";
// The honest reader of the all-work activity series (DW-4h-3 and DW-4i, docs/FRONTEND-BFF-CONTRACT.md section 44.3, 44.4):
//
//   GET /api/:t/activity/series?userId=&from=&to=   -> { userId, from, to, timezone, kinds, days, totals }
//   GET /api/:t/activity/day?userId=&date=          -> { userId, date, items }
//
// Three outcomes, never an empty series that stands in for a failed read (readiness criterion 5, `lib/readResult.ts`):
//   ok         the server answered, and the answer has the contract's shape. An all-zero series is evidence of quiet.
//   forbidden  403: the caller may not read this person (BFF 44.3: yourself, the company-wide and HR tiers, a head for their
//              led scope). Something may well be there; the caller is not told.
//   error      everything else: a 404 (the route is not served here), a 400, a 5xx, a timeout, and an answer of the wrong
//              shape. A 404 is NOT "no data": an older backend without section 44 must not read as "you did nothing".
//
// The shape guard builds the result from the known fields only, so a stray `total` or `score` key never travels on (there is
// no score, DW-D19), and it checks that the answer is for the person and the day that were asked for.
import { platformFetch, PlatformError } from "./platform";
import type { ActivityDay, ActivityDayItem, ActivityKind, ActivitySeries } from "./activitySeriesFormat";

export type ActivitySeriesResult =
  | { kind: "ok"; data: ActivitySeries }
  | { kind: "forbidden" }
  | { kind: "error"; reason: string };

export type ActivityDayResult =
  | { kind: "ok"; data: ActivityDay }
  | { kind: "forbidden" }
  | { kind: "error"; reason: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WRONG_SHAPE = "unexpected answer from the activity endpoint";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function countsOf(v: unknown): Record<string, number> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!isCount(n)) return null;
    out[k] = n;
  }
  return out;
}

/** The contract's series, or null when the answer is of any other shape. Exported for its tests. */
export function parseActivitySeries(raw: unknown, subjectUserId: string): ActivitySeries | null {
  if (!isRecord(raw)) return null;
  const { userId, from, to, timezone, kinds: rawKinds, days: rawDays, totals: rawTotals } = raw;
  if (userId !== subjectUserId) return null;
  if (typeof from !== "string" || !DATE_RE.test(from)) return null;
  if (typeof to !== "string" || !DATE_RE.test(to)) return null;
  if (!isStr(timezone)) return null;
  if (!Array.isArray(rawKinds) || !Array.isArray(rawDays)) return null;

  const kinds: ActivityKind[] = [];
  for (const k of rawKinds) {
    if (!isRecord(k) || !isStr(k.key) || !isStr(k.label) || !isStr(k.source)) return null;
    kinds.push({ key: k.key, label: k.label, source: k.source });
  }
  // The server zero-fills every day of the window, so a series without a day is not a series.
  if (rawDays.length === 0) return null;
  const days: ActivitySeries["days"] = [];
  for (const d of rawDays) {
    if (!isRecord(d) || typeof d.date !== "string" || !DATE_RE.test(d.date)) return null;
    const counts = countsOf(d.counts);
    if (!counts) return null;
    days.push({ date: d.date, counts });
  }
  const totals = countsOf(rawTotals);
  if (!totals) return null;
  return { userId: subjectUserId, from, to, timezone, kinds, days, totals };
}

/** The contract's day, or null when the answer is of any other shape. Exported for its tests. */
export function parseActivityDay(raw: unknown, subjectUserId: string, date: string): ActivityDay | null {
  if (!isRecord(raw)) return null;
  if (raw.userId !== subjectUserId || raw.date !== date) return null;
  if (!Array.isArray(raw.items)) return null;
  const items: ActivityDayItem[] = [];
  for (const it of raw.items) {
    if (!isRecord(it) || !isStr(it.kind) || typeof it.title !== "string" || typeof it.at !== "string") return null;
    if (it.link !== undefined && it.link !== null && typeof it.link !== "string") return null;
    items.push({ kind: it.kind, title: it.title, at: it.at, ...(typeof it.link === "string" && it.link !== "" ? { link: it.link } : {}) });
  }
  return { userId: subjectUserId, date, items };
}

function refusal(e: unknown): { kind: "forbidden" } | { kind: "error"; reason: string } {
  if (e instanceof PlatformError) {
    if (e.status === 403) return { kind: "forbidden" };
    return { kind: "error", reason: e.message };
  }
  // A timeout, a socket failure or a bug in the reader is a "cannot tell", never an empty series.
  return { kind: "error", reason: (e as Error)?.message ?? "unknown error" };
}

/**
 * `GET /activity/series` for `subjectUserId`. Without `from` and `to` the server answers its default year ending on its own
 * today in its reports time zone (`to` of the answer): the caller never needs the clock here to know what today is.
 */
export async function getActivitySeries(
  userId: string,
  tenantId: string,
  params: { subjectUserId: string; from?: string; to?: string },
): Promise<ActivitySeriesResult> {
  const qs = new URLSearchParams({ userId: params.subjectUserId });
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  try {
    const raw = await platformFetch<unknown>(`/api/${tenantId}/activity/series?${qs.toString()}`, userId);
    const data = parseActivitySeries(raw, params.subjectUserId);
    return data ? { kind: "ok", data } : { kind: "error", reason: WRONG_SHAPE };
  } catch (e) {
    return refusal(e);
  }
}

/** `GET /activity/day` for `subjectUserId` on `date`: the work's own names, newest first, up to 200. */
export async function getActivityDay(
  userId: string,
  tenantId: string,
  params: { subjectUserId: string; date: string },
): Promise<ActivityDayResult> {
  const qs = new URLSearchParams({ userId: params.subjectUserId, date: params.date });
  try {
    const raw = await platformFetch<unknown>(`/api/${tenantId}/activity/day?${qs.toString()}`, userId);
    const data = parseActivityDay(raw, params.subjectUserId, params.date);
    return data ? { kind: "ok", data } : { kind: "error", reason: WRONG_SHAPE };
  } catch (e) {
    return refusal(e);
  }
}
