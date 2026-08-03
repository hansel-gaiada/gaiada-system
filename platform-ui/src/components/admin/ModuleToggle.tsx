"use client";
import { useActionState } from "react";
import { Button, Eyebrow, StatusBadge, Toast } from "@/components/ui";

export interface AdminActionState {
  ok: boolean;
  error?: string;
}

// One module row: name + enabled/disabled badge + a toggle button. `action`
// is already bound by the page to (module, nextEnabled) — it just needs
// prev/formData to satisfy useActionState. `label`/`paths` come from the
// backend module catalog; `paths` are the nav routes this module owns, shown
// so it's clear what disabling it will dark (their endpoints 404 immediately —
// see platform-nest's ModuleEnabledGuard).
export function ModuleToggle({
  module,
  label,
  paths,
  enabled,
  action,
}: {
  module: string;
  label?: string;
  paths?: string[];
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
        borderBottom: "0.5px solid var(--line-soft)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Eyebrow style={{ fontSize: 10, opacity: 0.6 }}>{module}</Eyebrow>
        <span style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>{label ?? module}</span>
        {paths && paths.length > 0 && (
          <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>{paths.join(" · ")}</span>
        )}
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
