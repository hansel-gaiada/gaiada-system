"use client";
import { useActionState } from "react";
import type { FieldDef, Member, ProjectDetail } from "@/lib/entities";
import type { ProjectFormState } from "@/app/(app)/projects/actions";
import { Field } from "./Field";
import { CustomFields } from "./CustomFields";
import { Button } from "@/components/ui";
import "./forms.css";

const STATUS_OPTIONS = ["active", "on_hold", "completed", "archived"];

// `members` is accepted for parity with the task's owner-select ask, but is
// intentionally unused here: neither POST /projects nor PATCH /projects/:id
// accepts an ownerId, and there is no clients-list endpoint yet, so the
// owner and client pickers are deferred to a later slice — the form only
// submits fields the backend can actually persist.
export function ProjectForm({
  action,
  defs,
  members: _members,
  project,
}: {
  action: (prev: ProjectFormState | null, formData: FormData) => Promise<ProjectFormState>;
  defs: FieldDef[];
  members: Member[];
  project?: ProjectDetail;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 720 }}>
      <Field name="name" label="Name" required defaultValue={project?.name} />

      {project && (
        <>
          <Field name="status" label="Status" type="select" options={STATUS_OPTIONS} defaultValue={project.status} required />
          <Field name="startDate" label="Start date" type="date" defaultValue={project.start_date ?? undefined} />
          <Field name="dueDate" label="Due date" type="date" defaultValue={project.due_date ?? undefined} />
        </>
      )}

      <CustomFields defs={defs} values={project?.custom_fields} />

      {state?.error && (
        <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.8 }}>
          {state.error}
        </p>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? "Saving…" : project ? "Save changes" : "Create project"}
        </Button>
      </div>
    </form>
  );
}
