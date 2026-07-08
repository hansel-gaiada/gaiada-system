"use client";
import { useActionState } from "react";
import type { FieldDef, Member, TaskDetail } from "@/lib/entities";
import type { TaskFormState } from "@/app/(app)/tasks/actions";
import { Field } from "./Field";
import { CustomFields } from "./CustomFields";
import { Eyebrow } from "@/components/ui";
import { Button } from "@/components/ui";
import "./forms.css";

const STATUS_OPTIONS = ["todo", "in_progress", "blocked", "done"];
const PRIORITY_OPTIONS = ["low", "normal", "high", "urgent"];

// `projects` is accepted for interface parity with ProjectForm's `members`
// param, but create-mode doesn't render a project picker in the form itself —
// the project is chosen on a prior step (/tasks/new?projectId=) and bound
// into the action, since POST /projects/:pid/tasks only accepts title+customFields.
export function TaskForm({
  action,
  defs,
  members,
  task,
}: {
  action: (prev: TaskFormState | null, formData: FormData) => Promise<TaskFormState>;
  defs: FieldDef[];
  members: Member[];
  task?: TaskDetail;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 720 }}>
      <Field name="title" label="Title" required defaultValue={task?.title} />

      {task && (
        <>
          <Field name="status" label="Status" type="select" options={STATUS_OPTIONS} defaultValue={task.status ?? undefined} required />
          <Field name="priority" label="Priority" type="select" options={PRIORITY_OPTIONS} defaultValue={task.priority ?? undefined} />
          <label className="lux-field">
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Assignee</Eyebrow>
            <select name="assigneeId" defaultValue={task.assignee_id ?? ""} className="lux-field__control">
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <Field name="dueDate" label="Due date" type="date" defaultValue={task.due_date ?? undefined} />
        </>
      )}

      <CustomFields defs={defs} values={task?.custom_fields} />

      {state?.error && (
        <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.8 }}>
          {state.error}
        </p>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? "Saving…" : task ? "Save changes" : "Create task"}
        </Button>
      </div>
    </form>
  );
}
