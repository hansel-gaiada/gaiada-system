"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FieldDef } from "@/lib/entities";
import { CustomFields } from "@/components/forms/CustomFields";
import "@/components/forms/forms.css";

interface Props {
  taskId: string;
  defs: FieldDef[];
  values: Record<string, unknown>;
  canEdit: boolean;
  save: (taskId: string, formData: FormData) => Promise<{ ok: boolean; error?: string }>;
}

// D17 custom fields on a task (P2-03). Reuses the generic <CustomFields> renderer
// verbatim — no bespoke field-rendering here — wrapped in its own inline-save
// form so validation errors (unknown key / required / select option) surface
// right on this card, same pattern as ProgressControl/Subtasks.
export function TaskCustomFields({ taskId, defs, values, canEdit, save }: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (defs.length === 0) return null;

  return (
    <form
      action={(fd) =>
        startTransition(async () => {
          const r = await save(taskId, fd);
          if (r.ok) {
            setMsg(null);
            router.refresh();
          } else {
            setMsg(r.error ?? "Couldn't save custom fields.");
          }
        })
      }
    >
      <CustomFields defs={defs} values={values} />
      {msg && (
        <p style={{ margin: "10px 0 0", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>{msg}</p>
      )}
      {canEdit && (
        <div style={{ marginTop: 12 }}>
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </form>
  );
}
