// The ONE definition of `projects.status`: which values exist, and which of them mean "finished".
//
// PV2-09 (2026-10-11): the column was free text until migration 202610110151, which adds a CHECK with
// exactly `PROJECT_STATUSES`. The live survey before it found every project `active`, so nothing was
// mapped, and `done` / `complete` (in the PV2-01 list for older rows that turned out not to exist)
// left the set. Both project PATCH routes now refuse any other value with a 400 instead of letting the
// CHECK turn it into a 500.
//
// Meanings: "active" = NOT finished. "done" = a finished project that was actually delivered;
// archived and cancelled are finished but NOT done.
//
// These must agree, and `project-status.test.ts` pins them together:
//   - `PROJECT_STATUSES` here;
//   - the CHECK in `migrations/202610110151_projects_status_check.sql`;
//   - the staff form's options, `platform-ui/src/components/forms/ProjectForm.tsx` `STATUS_OPTIONS`.
// Pass these as bind parameters (`p.status = ANY($n::text[])`); never interpolate anything into SQL
// except these constants.
export const PROJECT_STATUSES = ["planned", "active", "on_hold", "completed", "cancelled", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const FINISHED_PROJECT_STATUSES = ["completed", "archived", "cancelled"] as const;
export const DONE_PROJECT_STATUSES = ["completed"] as const;

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value);
}

/** The 400 body both project PATCH routes return for a status outside the set. */
export function unknownProjectStatusError(): { message: string; field: "status" } {
  return { message: `unknown project status; use one of: ${PROJECT_STATUSES.join(", ")}`, field: "status" };
}
