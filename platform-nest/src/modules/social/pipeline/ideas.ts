// SCP-5 W5-B2 — "Ideas for next month": the PURE part (FRONTEND-BFF-CONTRACT §63.25). No I/O here: the bodies' validation, the
// company's metric rule, the fields "Add to next plan" gives the new post, and the idea's answer shape. The rows are `ideas-data.ts`'s,
// the transactions `ideas.service.ts`'s and the routes `ideas.controller.ts`'s.
//
// Every refusal of a body is the §63.0 400 `{error, field}`: `missing_field` for a field that is absent, `invalid_field` for one that is
// there and wrong. The company's rule (`ideas.metricRequired`, §63.30) decides whether `metric` may be absent; the column is nullable.
import { ScpRouteError } from "./pipeline-effects";
import type { IdeasRules } from "./rules";

export const IDEA_STATUSES = ["proposed", "shared", "planned"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const SAW_MAX = 500;
export const METRIC_MAX = 300;
export const SUGGESTION_MAX = 500;
/** The planned post's title and angle, cut (63.25.3 "Add to next plan"). */
export const POST_TITLE_MAX = 200;
export const POST_ANGLE_MAX = 500;
export const ANGLE_PREFIX = "From an idea: ";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Characters as the database counts them (code points), not UTF-16 units. */
export const charLen = (s: string): number => [...s].length;
/** The first `n` characters of `s` (code points), so a cut never splits a surrogate pair. */
export const cutChars = (s: string, n: number): string => (charLen(s) <= n ? s : [...s].slice(0, n).join(""));

const missing = (field: string): never => { throw new ScpRouteError(400, "missing_field", { field }); };
const invalid = (field: string): never => { throw new ScpRouteError(400, "invalid_field", { field }); };

/** A required text of 1 to `max` characters once trimmed: `missing_field` when absent or blank, `invalid_field` when not a string or too long. */
function requiredText(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return missing(field);
  if (typeof v !== "string") return invalid(field);
  const t = v.trim();
  if (t === "") return missing(field);
  if (charLen(t) > max) return invalid(field);
  return t;
}

/** The metric: absent, null and blank are "none". Present and wrong is `invalid_field`. */
function optionalMetric(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return invalid("metric");
  const t = v.trim();
  if (t === "") return null;
  if (charLen(t) > METRIC_MAX) return invalid("metric");
  return t;
}

export interface IdeaCreate {
  id: string | null;
  saw: string;
  metric: string | null;
  suggestion: string;
  reportId: string | null;
}

/** `POST engagements/:engagementId/ideas` (63.25.3): `{id?, saw, metric, suggestion, reportId?}`. 400 `{field}` in the order the fields are listed. */
export function parseIdeaCreate(body: unknown, rules: IdeasRules): IdeaCreate {
  if (!isObj(body)) return invalid("body");
  const allowed = ["id", "saw", "metric", "suggestion", "reportId"];
  for (const k of Object.keys(body)) if (!allowed.includes(k)) return invalid(k);
  let id: string | null = null;
  if (body.id !== undefined && body.id !== null) {
    if (!isUuid(body.id)) return invalid("id");
    id = body.id.toLowerCase();
  }
  const saw = requiredText(body.saw, "saw", SAW_MAX);
  const metric = optionalMetric(body.metric);
  if (metric === null && rules.metricRequired) return missing("metric");
  const suggestion = requiredText(body.suggestion, "suggestion", SUGGESTION_MAX);
  let reportId: string | null = null;
  if (body.reportId !== undefined && body.reportId !== null) {
    if (!isUuid(body.reportId)) return invalid("reportId");
    reportId = body.reportId.toLowerCase();
  }
  return { id, saw, metric, suggestion, reportId };
}

export interface IdeaPatch { saw?: string; metric?: string | null; suggestion?: string }

/**
 * `PATCH ideas/:ideaId` (63.25.3): `{saw?, metric?, suggestion?}`, at least one. A `metric` the patch touches is held to the company's rule
 * (cleared, it is `missing_field` when the metric is required); an idea made before the rule changed is not refused for a metric it never
 * had, so a patch that leaves `metric` alone is never judged on it.
 */
export function parseIdeaPatch(body: unknown, rules: IdeasRules): IdeaPatch {
  if (!isObj(body)) return invalid("body");
  for (const k of Object.keys(body)) if (!["saw", "metric", "suggestion"].includes(k)) return invalid(k);
  const out: IdeaPatch = {};
  if ("saw" in body) out.saw = requiredText(body.saw, "saw", SAW_MAX);
  if ("metric" in body) {
    out.metric = optionalMetric(body.metric);
    if (out.metric === null && rules.metricRequired) return missing("metric");
  }
  if ("suggestion" in body) out.suggestion = requiredText(body.suggestion, "suggestion", SUGGESTION_MAX);
  if (Object.keys(out).length === 0) return invalid("body");
  return out;
}

/** `POST ideas/:ideaId/plan` body: `{cycleId}`. 400 `{field: 'cycleId'}` when absent or not a uuid. */
export function parsePlanBody(body: unknown): { cycleId: string } {
  if (!isObj(body)) return invalid("cycleId");
  for (const k of Object.keys(body)) if (k !== "cycleId") return invalid(k);
  if (!isUuid(body.cycleId)) return invalid("cycleId");
  return { cycleId: body.cycleId.toLowerCase() };
}

/** `?status=&reportId=` on the list: each absent, or valid. */
export function parseIdeaFilter(q: { status?: unknown; reportId?: unknown }): { status: IdeaStatus | null; reportId: string | null } {
  let status: IdeaStatus | null = null;
  if (q.status !== undefined && q.status !== "") {
    if (typeof q.status !== "string" || !(IDEA_STATUSES as readonly string[]).includes(q.status)) return invalid("status");
    status = q.status as IdeaStatus;
  }
  let reportId: string | null = null;
  if (q.reportId !== undefined && q.reportId !== "") {
    if (!isUuid(q.reportId)) return invalid("reportId");
    reportId = q.reportId.toLowerCase();
  }
  return { status, reportId };
}

/** What "Add to next plan" gives the new post (63.25.3): the title is the suggestion cut at 200, the angle "From an idea: <saw> (<metric>)" cut at 500. */
export function planPostFields(idea: { saw: string; metric: string | null; suggestion: string }): { title: string; angle: string } {
  const angle = `${ANGLE_PREFIX}${idea.saw}${idea.metric ? ` (${idea.metric})` : ""}`;
  return { title: cutChars(idea.suggestion, POST_TITLE_MAX), angle: cutChars(angle, POST_ANGLE_MAX) };
}

/** `YYYY-MM` of an ISO day (`todayIsoInTz`'s answer). */
export const monthOfDay = (isoDay: string): string => isoDay.slice(0, 7);

/** 63.25.3: a cycle whose month is before the report month (today's month in the reports zone) is closed. `YYYY-MM` compares as text. */
export const cycleIsClosed = (cycleMonth: string, reportMonth: string): boolean => cycleMonth < reportMonth;

export interface IdeaAnswer {
  id: string;
  engagementId: string;
  saw: string;
  metric: string | null;
  suggestion: string;
  status: IdeaStatus;
  reportId: string | null;
  post: { id: string; title: string; pipelineStatus: string | null; cycleMonth: string | null } | null;
  sharedAt: string | null;
  sharedBy: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
  createdAt: string;
}
