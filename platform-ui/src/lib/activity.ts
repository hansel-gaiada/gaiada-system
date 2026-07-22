import "server-only";
// Work-activity / evidence model reader (P1-04 backend, P1-07 wires this UI —
// see docs/FRONTEND-BFF-CONTRACT.md §11, `src/core/work-activity.controller.ts`).
// The shapes below are the canonical F2 contract, exported verbatim per the
// ticket's own naming (`WorkActivityRow`). This module only wires the READ
// side — P1-05's outbox-driven auto-ingestion + historical backfill are a
// separate, not-yet-built ticket, so this may legitimately return `[]` even
// once the endpoint is deployed (no writers yet, or DEMO_MODE seed data only).
// Degrades to [] on 404/403 (route not deployed / module not authorized) —
// same house pattern as lib/pm.ts, lib/it.ts, lib/hr.ts.
//
// BFF CONTRACT (built):
//   GET /api/:t/work-activity?deptId=&projectId=&personId=&since=&limit= -> WorkActivityRow[]
import { platformFetch, PlatformError } from "./platform";

export type WorkActivitySource = "pm" | "pipeline" | "github" | "google_drive" | "claude" | "manual" | "system";
export type WorkActivityTargetKind = "pm_task" | "project" | "person" | "department";
export type WorkActivityConfidence = "exact" | "inferred";

export interface WorkActivityLink {
  targetKind: WorkActivityTargetKind;
  targetId: string;
  confidence: WorkActivityConfidence;
  rule: string;
}

// Canonical shape — matches docs/FRONTEND-BFF-CONTRACT.md §11 verbatim.
export interface WorkActivityRow {
  id: string;
  tenantId: string;
  source: WorkActivitySource;
  sourceRef: string;
  actorUserId: string | null;
  actorExternal: string | null;
  verb: string;
  objectKind: string;
  objectRef: string;
  title: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  originSite: string;
  createdAt: string;
  links: WorkActivityLink[];
}

async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

export interface WorkActivityQuery {
  deptId?: string;
  projectId?: string;
  personId?: string;
  since?: string;
  limit?: number;
}

export function listWorkActivity(u: string, t: string, q: WorkActivityQuery = {}): Promise<WorkActivityRow[]> {
  const params = new URLSearchParams();
  if (q.deptId) params.set("deptId", q.deptId);
  if (q.projectId) params.set("projectId", q.projectId);
  if (q.personId) params.set("personId", q.personId);
  if (q.since) params.set("since", q.since);
  if (q.limit) params.set("limit", String(q.limit));
  const qs = params.toString();
  return skipUnavailable(
    platformFetch<WorkActivityRow[]>(`/api/${t}/work-activity${qs ? `?${qs}` : ""}`, u),
    [] as WorkActivityRow[],
  );
}

// ================= Pure display helpers (unit-tested) =================
// These translate a WorkActivityRow into the dept-agnostic `ActivityItem`
// shape `components/departments/ActivityFeed.tsx` renders. Pure so the
// mapping is testable without a fetch; callers pass the mapped array in.

// "task.status_changed" -> "status changed"; a plain verb like "created"
// passes through unchanged.
export function humanizeVerb(verb: string): string {
  const last = verb.includes(".") ? verb.slice(verb.lastIndexOf(".") + 1) : verb;
  return last.replace(/_/g, " ");
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// e.g. "Task: Fix login redirect" — matches the ActivityFeed contract's own
// doc example (`objectLabel: "Task: Fix login redirect"`).
export function objectLabel(row: Pick<WorkActivityRow, "objectKind" | "title" | "objectRef">): string {
  const kind = capitalize(row.objectKind.replace(/_/g, " "));
  return `${kind}: ${row.title ?? row.objectRef}`;
}

// Best-effort deep link from the row's own fields — no extra fetch, never a
// dead link (undefined renders as plain, unlinked text in ActivityFeed).
export function activityHref(row: Pick<WorkActivityRow, "objectKind" | "objectRef">): string | undefined {
  switch (row.objectKind) {
    case "pm_task":
    case "task":
      return `/tasks/${row.objectRef}`;
    case "project":
      return `/projects/${row.objectRef}`;
    default:
      return undefined;
  }
}

// Actor display name — looks the row's actorUserId up in a caller-supplied
// {id:name} map (e.g. built from lib/entities.listMembers) so this stays a
// pure function; falls back to actorExternal for non-platform actors, or the
// raw id if the map doesn't have a name (never silently drops the actor).
export function actorLabel(row: Pick<WorkActivityRow, "actorUserId" | "actorExternal">, names: Record<string, string>): string | null {
  if (row.actorUserId) return names[row.actorUserId] ?? row.actorUserId;
  return row.actorExternal;
}
