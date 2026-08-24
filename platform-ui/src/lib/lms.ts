import "server-only";
// LMS data layer (L1). Design: docs/blueprints/lms-foundation.md.
//
// Its OWN module (`lms`), not filed under `hr` — so these routes 404 unless the company has `lms`
// enabled or served, independently of HR. Every reader DEGRADES GRACEFULLY (empty on 403/404), the
// pattern lib/hr.ts and lib/hr-full.ts already use.
//
// ⚠ TWO EXCEPTIONS, deliberately. `getCourse` and `getMyLearning` do NOT degrade:
//   * an empty COURSE renders as "this course has no content", which is indistinguishable from
//     "you cannot read it" — and a learner told a mandatory course is empty will stop looking.
//   * an empty MY-LEARNING page reads as "you have no training assigned", which is the single most
//     consequential wrong answer this surface can give: somebody skips mandatory training because
//     the page told them there was none.
//   "An empty list is a CLAIM" applies with unusual force here.
//
// BFF CONTRACT (mounted /api/:t/modules/lms/*):
//   GET/POST   /courses[?track&unitNodeId&discipline&level&status]  -> Course[] / {id}
//   GET        /courses/:id                                         -> CourseDetail
//   PATCH      /courses/:id                                         -> {id, versioned, version}
//   POST       /courses/:id/publish | /retire                       -> {ok}
//   POST       /courses/:id/modules                                 -> {id}
//   POST       /modules/:id/activities                              -> {id}
//   DELETE     /activities/:id                                      -> {ok}
//   GET/POST   /paths[?track&mandatory]                             -> Path[] / {id}
//   POST       /paths/:id/courses | /publish                        -> {ok}
//   GET        /me                                                  -> MyLearning
//   GET/POST   /enrollments[?subjectUserId&status]                  -> Enrollment[] / {id}
//   POST       /enrollments/:id/waive                               -> {ok}
//   POST       /activities/:id/attempts                             -> AttemptResult
//   POST       /attempts/:id/grade                                  -> {ok}
//   GET        /compliance                                          -> ComplianceRow[]
import { platformFetch, PlatformError } from "./platform";

const base = (t: string) => `/api/${t}/modules/lms`;

// ⚠ ARGUMENT ORDER IS `platformFetch(path, userId)`, NOT `(userId, path)`. Every reader below had
// them swapped when this file was first written; both parameters are `string`, so `tsc` and the
// whole vitest suite passed, and the demo/live backend simply never saw an LMS path — the fixture
// catch-all answered `[]` and the catalogue rendered "nothing published yet". Only driving the
// rendered page caught it. That is the frontend-first drift class this repo keeps getting bitten
// by: a confident wrong answer with nothing thrown.

async function soft<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) return fallback;
    throw e;
  }
}
/** For reads whose emptiness would be read as a fact rather than as an absence. Rethrows. */
const strict = <T>(fn: () => Promise<T>): Promise<T> => fn();

// ─────────────────────────────────────────────────────────────────────── types ────────────────
export type Track = "general" | "department";
export type Level = "foundation" | "practitioner" | "advanced" | "lead";
export type CourseStatus = "draft" | "in_review" | "published" | "retired";
export type ActivityKind = "read" | "watch" | "quiz" | "scenario" | "lab";
export type Grading = "auto" | "review" | "none";

export const LEVELS: Level[] = ["foundation", "practitioner", "advanced", "lead"];
/** Ordered so a UI can render a progression rather than an alphabetical jumble. */
export const LEVEL_LABEL: Record<Level, string> = {
  foundation: "Foundation", practitioner: "Practitioner", advanced: "Advanced", lead: "Lead / management",
};

export interface Course {
  id: string; courseKey: string; version: number; title: string; summary: string | null;
  track: Track; unitNodeId: string | null; discipline: string | null; level: Level;
  status: CourseStatus; estimatedMinutes: number | null; publishedAt: string | null; createdAt: string;
}
export interface Activity {
  id: string; moduleId: string; sortOrder: number; kind: ActivityKind; title: string;
  spec: Record<string, unknown>; isRequired: boolean; passThreshold: string | null;
  grading: Grading; maxAttempts: number | null; estimatedMinutes: number | null;
}
export interface CourseDetail extends Course {
  knowledgeSourceId: string | null; authoredBy: string | null;
  modules: { id: string; sortOrder: number; title: string; summary: string | null; activities: Activity[] }[];
}
export interface LearningPath {
  id: string; pathKey: string; title: string; summary: string | null; track: Track;
  unitNodeId: string | null; discipline: string | null; level: Level; status: CourseStatus;
  isMandatory: boolean; appliesTo: string; dueDays: number | null;
  certificationValidMonths: number | null; certificationLabel: string | null; courseCount: number;
}
export interface Enrollment {
  id: string; subjectUserId: string; subjectName: string | null; pathId: string; pathKey: string;
  title: string; isMandatory: boolean; status: "assigned" | "in_progress" | "completed" | "waived" | "expired";
  source: string; dueOn: string | null; completedAt: string | null;
}
export interface MyEnrollment extends Omit<Enrollment, "subjectName" | "subjectUserId"> {
  overdue: boolean; startedAt: string | null; coursesRequired: number; coursesCompleted: number;
}
export interface MyLearning {
  enrolments: MyEnrollment[];
  certifications: { pathKey: string; completedAt: string; expiresOn: string | null; finalScore: string | null }[];
}
export interface ComplianceRow {
  pathKey: string; title: string; isMandatory: boolean;
  assigned: number; completed: number; outstanding: number; overdue: number; waived: number;
}

// ───────────────────────────────────────────────────────────────────── readers ────────────────
export const listCourses = (
  u: string, t: string,
  q: { track?: Track; unitNodeId?: string; discipline?: string; level?: Level; status?: CourseStatus } = {},
) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return soft(() => platformFetch<Course[]>(`${base(t)}/courses${qs ? `?${qs}` : ""}`, u), []);
};

/** Rethrows — an empty course is indistinguishable from an unreadable one. See the header. */
export const getCourse = (u: string, t: string, id: string) =>
  strict(() => platformFetch<CourseDetail>(`${base(t)}/courses/${id}`, u));

export const listPaths = (u: string, t: string, q: { track?: Track; mandatory?: boolean } = {}) => {
  const qs = new URLSearchParams();
  if (q.track) qs.set("track", q.track);
  if (q.mandatory) qs.set("mandatory", "true");
  return soft(() => platformFetch<LearningPath[]>(`${base(t)}/paths${qs.toString() ? `?${qs}` : ""}`, u), []);
};

/** Rethrows — "you have no training assigned" is the worst wrong answer this surface can give. */
export const getMyLearning = (u: string, t: string) =>
  strict(() => platformFetch<MyLearning>(`${base(t)}/me`, u));

export const listEnrollments = (u: string, t: string, q: { subjectUserId?: string; status?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return soft(() => platformFetch<Enrollment[]>(`${base(t)}/enrollments${qs ? `?${qs}` : ""}`, u), []);
};

export const getCompliance = (u: string, t: string) =>
  soft(() => platformFetch<ComplianceRow[]>(`${base(t)}/compliance`, u), []);

// ─────────────────────────────────────────────────────────────────── formatting ───────────────
/** Minutes to a human duration. Kept here so the same number never renders two ways. */
export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Completion as a fraction, and NULL when there is nothing to complete.
 *
 * A path with zero required courses is misconfigured, not 100% done — the same distinction the
 * analytics turnover rate makes. Rendering it as complete would tell somebody they had passed
 * training that does not exist.
 */
export function completionPct(done: number, required: number): number | null {
  if (required <= 0) return null;
  return Math.round((done / required) * 100);
}

/** A due date's urgency, for a badge. `null` when there is no due date at all. */
export function dueState(dueOn: string | null, status: string): "overdue" | "due-soon" | "ok" | null {
  if (!dueOn || status === "completed" || status === "waived") return null;
  const days = Math.ceil((new Date(dueOn).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "overdue";
  if (days <= 7) return "due-soon";
  return "ok";
}
