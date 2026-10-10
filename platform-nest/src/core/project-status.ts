// The ONE definition of which `projects.status` values mean "finished".
//
// The staff project form (`platform-ui/src/components/forms/ProjectForm.tsx:10`) offers
// active / on_hold / completed / archived, while older rows and imports carry done / complete /
// cancelled. Hand-written lists in three SQL call sites once disagreed, so a project staff marked
// "completed" was counted, sorted and coloured as active (PV2-01).
//
// Meanings: "active" = NOT finished. "done" = a finished project that was actually delivered;
// archived and cancelled are finished but NOT done.
//
// `ProjectForm.tsx:10` and the future `projects.status` CHECK constraint (PV2-09) must agree with
// this list. Pass these as bind parameters (`p.status = ANY($n::text[])`); never interpolate
// anything into SQL except these constants.
export const FINISHED_PROJECT_STATUSES = ["done", "complete", "completed", "archived", "cancelled"] as const;
export const DONE_PROJECT_STATUSES = ["done", "complete", "completed"] as const;
