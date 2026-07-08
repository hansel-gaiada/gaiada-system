"use client";
import { useActionState } from "react";
import type { BriefFormState } from "@/app/(app)/agency/actions";
import { Field } from "./Field";
import { Button } from "@/components/ui";
import "./forms.css";

export function BriefForm({
  action,
}: {
  action: (prev: BriefFormState | null, formData: FormData) => Promise<BriefFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 720 }}>
      <Field name="title" label="Title" required />
      <Field name="body" label="Body" type="textarea" />

      {state?.error && (
        <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.8 }}>
          {state.error}
        </p>
      )}

      <div style={{ gridColumn: "1 / -1" }}>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? "Saving…" : "Add brief"}
        </Button>
      </div>
    </form>
  );
}
