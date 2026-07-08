"use client";
import { useActionState } from "react";
import type { FieldDef } from "@/lib/entities";
import { Button, Eyebrow, StatusBadge, Toast } from "@/components/ui";
import { Field } from "@/components/forms/Field";

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

const DATA_TYPES = ["text", "number", "boolean", "date", "select"];

// One field-def row: key/label/type + a required badge + a delete button.
// `deleteAction` is bound by the page to a specific entityType, then bound
// again here to the def's key/id — deletion degrades gracefully until DELETE
// /api/:t/custom-fields/:id lands.
function FieldDefRow({
  def,
  deleteAction,
}: {
  def: FieldDef;
  deleteAction: (prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
}) {
  const [state, formAction, pending] = useActionState(deleteAction, null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 0",
        borderBottom: "0.5px solid rgba(26,25,22,.12)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>
          {def.label} <span style={{ color: "rgba(26,25,22,.45)", fontSize: 12 }}>({def.key})</span>
        </span>
        <span style={{ font: "400 12px var(--font-body)", color: "rgba(26,25,22,.5)" }}>
          {def.data_type}
          {def.options?.length ? ` — ${def.options.join(", ")}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {def.required && <StatusBadge label="Required" />}
        <form action={formAction}>
          <Button type="submit" variant="ghost" size="sm" disabled={pending}>
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </form>
      </div>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && <Toast message="Field deleted." />}
    </div>
  );
}

// Manages the custom-field definitions for one entity type: a list of
// existing defs (each deletable) plus an add-field mini-form. `createAction`
// is bound by the page to entityType — creating is real (POST
// /api/:t/custom-fields); `deleteAction` is likewise bound to entityType,
// then re-bound per row to the def's key.
export function FieldDefManager({
  entityType,
  defs,
  createAction,
  deleteAction,
}: {
  entityType: string;
  defs: FieldDef[];
  createAction: (prev: AdminActionState | null, formData: FormData) => Promise<AdminActionState>;
  deleteAction: (key: string, prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
}) {
  const [createState, createFormAction, createPending] = useActionState(createAction, null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {defs.length === 0 ? (
        <p style={{ margin: "4px 0 8px", font: "400 13px var(--font-body)", color: "rgba(26,25,22,.5)" }}>
          No custom fields defined for {entityType} yet.
        </p>
      ) : (
        defs.map((def) => (
          <FieldDefRow key={def.key} def={def} deleteAction={deleteAction.bind(null, def.key)} />
        ))
      )}

      <form
        action={createFormAction}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginTop: 12 }}
      >
        <Field name="key" label="Key" type="text" required />
        <Field name="label" label="Label" type="text" required />
        <label className="lux-field">
          <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Data type</Eyebrow>
          <select name="dataType" defaultValue="text" className="lux-field__control" aria-label="Data type">
            {DATA_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <Field name="options" label="Options (comma-separated, for select)" type="text" />
        <Field name="required" label="Required" type="boolean" />
        <Button type="submit" size="sm" disabled={createPending}>
          {createPending ? "Adding…" : "Add field"}
        </Button>
      </form>

      {createState?.error && <Toast message={createState.error} />}
      {createState?.ok && <Toast message="Field added." />}
    </div>
  );
}
