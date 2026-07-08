"use client";
import { useActionState } from "react";
import type { ComplianceGate } from "@/lib/adminData";
import { Button, StatusBadge, Toast } from "@/components/ui";
import { Field } from "@/components/forms/Field";

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

const STATUSES = ["open", "in_progress", "passed", "waived"];

// One gate's current status badge + a compact edit form (status select +
// evidence URL). `action` is already bound by the page to the gate's id — it
// just needs prev/formData to satisfy useActionState. Degrades gracefully
// (friendly toast) until PATCH /api/:t/compliance-gates/:id lands — see
// lib/adminData.ts.
export function GateStatusForm({
  gate,
  action,
}: {
  gate: ComplianceGate;
  action: (prev: AdminActionState | null, formData: FormData) => Promise<AdminActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StatusBadge label={gate.status} />
      </div>
      <form
        action={formAction}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}
      >
        <Field name="status" label="Status" type="select" options={STATUSES} defaultValue={gate.status} required />
        <Field name="evidence_url" label="Evidence URL" type="text" defaultValue={gate.evidence_url ?? ""} />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && <Toast message="Gate updated." />}
    </div>
  );
}
