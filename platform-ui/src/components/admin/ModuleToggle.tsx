"use client";
import { useActionState } from "react";
import { Button, Eyebrow, StatusBadge, Toast } from "@/components/ui";

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

// One module row: name + enabled/disabled badge + a toggle button. `action`
// is already bound by the page to (module, nextEnabled) — it just needs
// prev/formData to satisfy useActionState. Degrades gracefully (friendly
// toast) until PATCH /api/:t/company/modules lands — see lib/adminData.ts.
export function ModuleToggle({
  module,
  enabled,
  action,
}: {
  module: string;
  enabled: boolean;
  action: (prev: AdminActionState | null, formData?: FormData) => Promise<AdminActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 0",
        borderBottom: "0.5px solid rgba(26,25,22,.12)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>Module</Eyebrow>
        <span style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>{module}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <StatusBadge label={enabled ? "Enabled" : "Disabled"} />
        <form action={formAction}>
          <Button type="submit" variant={enabled ? "ghost" : "solid"} size="sm" disabled={pending}>
            {pending ? "Updating…" : enabled ? "Disable" : "Enable"}
          </Button>
        </form>
      </div>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && <Toast message={`Module ${enabled ? "disabled" : "enabled"}.`} />}
    </div>
  );
}
