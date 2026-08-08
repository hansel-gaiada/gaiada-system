// MI-05 — Web Dev maintenance intake, staff console half. Client-safe types + pure helpers only
// (no fetch, no server-only import) — mirrors the lib/pipeline.ts split so this file is importable
// from the "use client" queue/drawer component as well as server pages and plain vitest.
//
// Design: docs/superpowers/plans/2026-08-07-webdev-maintenance-intake-design.md
//   §2.2 — the CR lifecycle (new -> declined | new -> in_progress -> done)
//   §2.3 — the routing-by-kind table (the DEFAULT rendered here is a SUGGESTION; the triaging PM's
//          explicit route choice always wins — "the PM's triage decision is the record")
// Backend: platform-nest/src/core/webdev-change-requests.controller.ts (MI-03, DEV-VERIFIED).

export type CrKind = "content" | "design" | "feature" | "bug";
export type CrStatus = "new" | "triaged" | "in_progress" | "done" | "declined";
export type CrRoute = "control_plane" | "mini_run" | "pm_task";
export type CrSource = "portal" | "internal";

export const KINDS: CrKind[] = ["content", "design", "feature", "bug"];
export const ROUTES: CrRoute[] = ["control_plane", "mini_run", "pm_task"];

export const KIND_LABEL: Record<CrKind, string> = {
  content: "Content",
  design: "Design",
  feature: "Feature",
  bug: "Bug",
};

export const STATUS_LABEL: Record<CrStatus, string> = {
  new: "New",
  triaged: "Triaged",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
};

export const ROUTE_LABEL: Record<CrRoute, string> = {
  control_plane: "Control plane (webdesk P4 — not available yet)",
  mini_run: "Mini pipeline run",
  pm_task: "PM task",
};

// §2.3's table, VERBATIM from the controller's own DEFAULT_ROUTE_BY_KIND (webdev-change-requests
// .controller.ts:47-52) — rendered in the drawer as a SUGGESTED starting point, never forced: the PM
// may always override it (an explicit `route` in the triage POST wins server-side regardless).
export const DEFAULT_ROUTE_BY_KIND: Record<CrKind, CrRoute> = {
  content: "pm_task",
  design: "mini_run",
  feature: "mini_run",
  bug: "pm_task",
};

/** The list-row shape returned by GET /:t/webdev/change-requests (and embedded in the detail read). */
export interface ChangeRequestRow {
  id: string;
  clientId: string | null;
  clientName: string | null;
  projectId: string | null;
  projectName: string | null;
  source: CrSource;
  kind: CrKind;
  title: string;
  status: CrStatus;
  route: CrRoute | null;
  pipelineRunId: string | null;
  pmTaskId: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  triagedBy: string | null;
  triagedByName: string | null;
  triagedAt: string | null;
  declinedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The detail read additionally joins body + the linked run/task's live status (§2.2: "the CR
 *  detail joins the linked run/task at read time, so status is live regardless"). */
export interface ChangeRequestDetail extends ChangeRequestRow {
  body: string | null;
  runStatus: string | null;
  runTitle: string | null;
  taskTitle: string | null;
  taskStatus: string | null;
}

/** The 409 "already triaged" artifact a race loser (or a double-click) gets back — see the
 *  controller's `already_triaged` outcome. Carried so the UI can navigate to what already exists
 *  instead of just reporting failure. */
export interface ExistingTriageArtifact {
  status: CrStatus;
  route: CrRoute | null;
  pipelineRunId: string | null;
  pmTaskId: string | null;
}

/** Queue ordering (MI-05 AC: "queue orders status='new' first"). The backend's own list SELECT
 *  already orders `created_at ASC` (oldest-first WITHIN the queue, ix_wcr_new's rationale) but does
 *  NOT segregate `new` from the rest when no status filter is applied — this tab shows every status
 *  so triagers can see recently-disposed rows too, so the client-side sort does the segregation:
 *  every `new` row first (in the backend's given order, i.e. oldest-new-first), then everything else
 *  (again in the order given). A stable partition, not a re-sort within each group, so the backend's
 *  createdAt ordering is preserved verbatim within each half. */
export function sortQueue<T extends { status: CrStatus }>(rows: T[]): T[] {
  const fresh: T[] = [];
  const rest: T[] = [];
  for (const r of rows) (r.status === "new" ? fresh : rest).push(r);
  return [...fresh, ...rest];
}

/** The drawer's suggested route for a kind (possibly overridden by a `kindOverride`). Pure so the
 *  suggestion can be unit-tested against §2.3's table without a live triage call. */
export function suggestedRoute(kind: CrKind): CrRoute {
  return DEFAULT_ROUTE_BY_KIND[kind];
}

/** Where a converted CR's linked artifact should be opened from the staff console (§7's "detail
 *  links out to /pipeline/[runId]... and to the PM task"). Null when nothing is spawned yet. */
export function linkedArtifactHref(row: Pick<ChangeRequestRow, "route" | "pipelineRunId" | "pmTaskId">): string | null {
  if (row.route === "mini_run" && row.pipelineRunId) return `/pipeline/${row.pipelineRunId}`;
  if (row.route === "pm_task" && row.pmTaskId) return `/tasks/${row.pmTaskId}`;
  return null;
}
