"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Card } from "@/components/ui";
import type { LmsResult } from "@/lib/lmsActions";
import "@/components/forms/forms.css";

const LEVELS = ["foundation", "practitioner", "advanced", "lead"];

/**
 * Authoring a new course (L3 — "each HOD makes more").
 *
 * `unitOptions` carries the departments this person may author for. It is a CONVENIENCE, not a
 * boundary: Cerbos resolves the course's org-unit ancestry server-side and refuses a unit the
 * caller does not lead, whatever this select offered. Rendering a unit here that the server would
 * reject produces an honest 403 rather than a silent write to somebody else's department.
 */
export function CourseForm({ create, unitOptions }: {
  create: (formData: FormData) => Promise<LmsResult>;
  unitOptions: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [field, setField] = useState<string | undefined>();
  const [track, setTrack] = useState("department");
  const [pending, startTransition] = useTransition();

  const onSubmit = (formData: FormData) => {
    startTransition(async () => {
      const res = await create(formData);
      if (res.ok) {
        setMsg(null);
        setField(undefined);
        setOpen(false);
        router.refresh();
        if (res.id) router.push(`/learning/authoring/${res.id}`);
      } else {
        setMsg(res.error ?? "Couldn't create the course.");
        setField(res.field);
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
        New course
      </button>
    );
  }

  return (
    <Card title="New course" style={{ marginBottom: 20 }}>
      <form action={onSubmit} className="lux-form-grid">
        <Field
          name="courseKey" label="Course key" required
          error={field === "courseKey" ? msg ?? undefined : undefined}
          // The key outlives every title change and every version. Said here because an author who
          // learns this after publishing cannot take it back.
          hint="Lowercase letters, numbers and hyphens. This is the PERMANENT identity — it survives title changes and every new version, so pick it as you would a URL."
        />
        <Field name="title" label="Title" required error={field === "title" ? msg ?? undefined : undefined} />
        <Field name="summary" label="Summary" type="textarea" hint="One or two sentences: what somebody will be able to do afterwards." />
        <label className="lux-field">
          <span className="lux-field__label">Track</span>
          <span className="lux-field__selectwrap">
            <select
              name="track" value={track} onChange={(e) => setTrack(e.target.value)}
              className="lux-field__control"
            >
              <option value="department">A department&apos;s own material</option>
              <option value="general">General — every employee</option>
            </select>
          </span>
        </label>
        {track === "department" ? (
          <Field
            name="unitNodeId" label="Department" type="select" optionItems={unitOptions} required
            error={field === "unitNodeId" ? msg ?? undefined : undefined}
            hint="You may author for the departments you lead. The server checks this again."
          />
        ) : (
          // Stated rather than merely hidden: a general course is the mandatory track, and
          // authoring it is a company-administrator act, not a department head's.
          <p style={{ gridColumn: "1 / -1", margin: 0, font: "400 13px/1.6 var(--font-body)", color: "var(--erp-ink-60)" }}>
            A general-track course belongs to no department — it is material every employee takes.
            Only a company administrator can author one, and the server will refuse if you are not.
          </p>
        )}
        <Field name="discipline" label="Discipline" hint="Optional. FE, BE, UI/UX, DevOps, Cyber Security, QA — whatever your department calls its subdivisions." />
        <Field name="level" label="Level" type="select" options={LEVELS} defaultValue="foundation"
               hint="Foundation through lead. The lead tier is the management-facing version of the same discipline." />
        <Field name="estimatedMinutes" label="Estimated minutes" type="number" />
        {msg && !field && (
          <p role="alert" style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
            {msg}
          </p>
        )}
        <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
            {pending ? "Creating…" : "Create draft"}
          </button>
          <button
            type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}
            onClick={() => { setOpen(false); setMsg(null); setField(undefined); }}
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
