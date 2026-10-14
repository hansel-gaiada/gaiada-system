"use client";
// The task page's Delete. It was a plain form on `deleteTaskAction`, which ignored the result and always went to the
// project page, so a REFUSED delete looked like a successful one. DW-5 (BFF §32.8) made that refusal real: a task
// that carries an open request between departments answers 409 `task_has_open_request`. Now the button waits for the
// answer: success goes to the project as before; a refusal stays here and says why, in the platform's own words.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteTask } from "@/lib/pmActions";

export function DeleteTaskButton({ taskId, projectId }: { taskId: string; projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onDelete = () =>
    startTransition(async () => {
      setError(null);
      const r = await deleteTask(taskId, projectId);
      if (r.ok) {
        router.push(`/projects/${projectId}`);
        return;
      }
      setError(r.error ?? "The task could not be deleted.");
    });

  return (
    <>
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onDelete} disabled={pending} aria-busy={pending}>
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && (
        <p role="alert" className="pm-task-delete-error">
          {error}
        </p>
      )}
    </>
  );
}
