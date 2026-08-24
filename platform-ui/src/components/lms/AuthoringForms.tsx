"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { LmsResult } from "@/lib/lmsActions";
import "@/components/forms/forms.css";

const KINDS = ["read", "watch", "quiz", "scenario", "lab"];
const GRADINGS = ["none", "auto", "review"];

/** Shared submit/inline-error plumbing. Both forms below have the same shape and the same failure. */
function useAction(action: (fd: FormData) => Promise<LmsResult>, onDone: () => void) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [field, setField] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const submit = (formData: FormData) => {
    startTransition(async () => {
      const res = await action(formData);
      if (res.ok) {
        setMsg(null); setField(undefined); onDone(); router.refresh();
      } else {
        setMsg(res.error ?? "That didn't work."); setField(res.field);
      }
    });
  };
  return { submit, msg, field, pending };
}

export function ModuleForm({ add, courseId, nextOrder }: {
  add: (formData: FormData) => Promise<LmsResult>;
  courseId: string;
  nextOrder: number;
}) {
  const [open, setOpen] = useState(false);
  const { submit, msg, field, pending } = useAction(add, () => setOpen(false));

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>
        Add a module
      </button>
    );
  }
  return (
    <Card title="New module">
      <form action={submit} className="lux-form-grid">
        <input type="hidden" name="courseId" value={courseId} />
        <Field name="title" label="Title" required error={field === "title" ? msg ?? undefined : undefined} />
        <Field name="summary" label="Summary" type="textarea" />
        <Field
          name="sortOrder" label="Position" type="number" defaultValue={nextOrder}
          // Gaps by default so a later insertion between two modules needs no renumbering.
          hint="Modules render in this order. Spaced in tens so you can slot one in between later."
        />
        {msg && !field && (
          <p role="alert" style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Adding…" : "Add module"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * A new activity.
 *
 * The `spec` field is raw JSON, and that is a deliberate L3 choice rather than a shortcut: the
 * shape differs per kind (prose for a reading, questions for a quiz, a challenge spec for a lab)
 * and the lab shape is not designed yet — L5 is where the runner arrives. A typed builder now would
 * be a builder for three kinds and a dead end for two. The action validates what it can: a quiz
 * needs `questions`, every question needs an `answer`, a lab must be auto-graded.
 */
export function ActivityForm({ add, moduleId, courseId, nextOrder }: {
  add: (formData: FormData) => Promise<LmsResult>;
  moduleId: string;
  courseId: string;
  nextOrder: number;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("read");
  const { submit, msg, field, pending } = useAction(add, () => setOpen(false));

  const specHint =
    kind === "quiz"
      ? '{"questions":[{"id":"q1","prompt":"…","options":["a","b"],"answer":1,"explanation":"…"}]}'
      : kind === "read"
        ? '{"body":"The prose the learner reads. Markdown is fine."}'
        : kind === "watch"
          ? '{"url":"https://…","body":"What to look for while watching."}'
          : kind === "scenario"
            ? '{"brief":"What to produce.","rubric":["criterion one","criterion two"]}'
            : '{"challenge":"…"}  — the lab runner arrives at L5; a lab authored now cannot be graded yet.';

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(true)}>
        Add an activity
      </button>
    );
  }
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "0.5px solid var(--erp-hairline)" }}>
      <form action={submit} className="lux-form-grid">
        <input type="hidden" name="moduleId" value={moduleId} />
        <input type="hidden" name="courseId" value={courseId} />
        <Field name="title" label="Title" required error={field === "title" ? msg ?? undefined : undefined} />
        <label className="lux-field">
          <span className="lux-field__label">Kind</span>
          <span className="lux-field__selectwrap">
            <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className="lux-field__control">
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </span>
        </label>
        <Field
          name="grading" label="Grading" type="select" options={GRADINGS}
          defaultValue={kind === "quiz" || kind === "lab" ? "auto" : "none"}
          error={field === "grading" ? msg ?? undefined : undefined}
          // The owner's "mixed grading by discipline" decision, in one sentence at the point of use.
          hint="auto = machine-marked · review = a person marks it · none = completion only. Reviewed is right for design and management scenarios, where auto-grading teaches people to satisfy the grader."
        />
        <Field
          name="passThreshold" label="Pass mark (%)" type="number"
          error={field === "passThreshold" ? msg ?? undefined : undefined}
          hint="Required for anything auto-graded that is not a reading or a video."
        />
        <Field name="maxAttempts" label="Max attempts" type="number" hint="Leave empty for unlimited. Learners are shown this before their first attempt." />
        <Field name="estimatedMinutes" label="Estimated minutes" type="number" />
        <Field name="sortOrder" label="Position" type="number" defaultValue={nextOrder} />
        <Field name="isRequired" label="Required to complete the course" type="boolean" defaultValue />
        <Field
          name="spec" label="Body (JSON)" type="textarea"
          error={field === "spec" ? msg ?? undefined : undefined}
          hint={specHint}
        />
        {msg && !field && (
          <p role="alert" style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Adding…" : "Add activity"}
          </button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
