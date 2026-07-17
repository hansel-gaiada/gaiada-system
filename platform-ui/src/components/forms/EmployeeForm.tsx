"use client";
import { useActionState } from "react";
import { Field } from "./Field";
import { Eyebrow, Button } from "@/components/ui";
import "./forms.css";

export interface EmployeeFormState { error?: string }

export function EmployeeForm({
  action, mode, roles = [], employee,
}: {
  action: (prev: EmployeeFormState | null, formData: FormData) => Promise<EmployeeFormState>;
  mode: "invite" | "edit";
  roles?: { id: string; name: string }[];
  employee?: { name: string; email: string; title: string | null; status: string };
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="lux-form-grid" style={{ maxWidth: 640 }}>
      {mode === "invite" ? (
        <>
          <Field name="name" label="Full name" required />
          <Field name="email" label="Work email" type="text" required />
          <Field name="title" label="Job title" />
          <label className="lux-field">
            <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Initial role (this company)</Eyebrow>
            <select name="roleId" className="lux-field__control" defaultValue="">
              <option value="">— no role yet —</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        </>
      ) : (
        <>
          <Field name="name" label="Full name" required defaultValue={employee?.name} />
          <Field name="title" label="Job title" defaultValue={employee?.title ?? undefined} />
          <Field name="status" label="Status" type="select" options={["active", "invited", "suspended", "offboarded"]} defaultValue={employee?.status ?? "active"} />
        </>
      )}

      {state?.error && (
        <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{state.error}</p>
      )}
      <div style={{ gridColumn: "1 / -1" }}>
        <Button type="submit" size="md" disabled={pending}>
          {pending ? "Saving…" : mode === "invite" ? "Send invite" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
