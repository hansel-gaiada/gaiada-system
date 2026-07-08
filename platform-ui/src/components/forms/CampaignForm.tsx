"use client";
import { useActionState } from "react";
import type { Project } from "@/lib/entities";
import type { CampaignFormState } from "@/app/(app)/agency/actions";
import { Field } from "./Field";
import { Button, Eyebrow } from "@/components/ui";
import "./forms.css";

export function CampaignForm({
  action,
  projects,
}: {
  action: (prev: CampaignFormState | null, formData: FormData) => Promise<CampaignFormState>;
  projects: Project[];
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 720 }}>
      <Field name="name" label="Name" required />
      <label className="lux-field">
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Project</Eyebrow>
        <select name="projectId" defaultValue="" required className="lux-field__control">
          <option value="" disabled hidden />
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>

      {state?.error && (
        <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.8 }}>
          {state.error}
        </p>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? "Saving…" : "Create campaign"}
        </Button>
      </div>
    </form>
  );
}
