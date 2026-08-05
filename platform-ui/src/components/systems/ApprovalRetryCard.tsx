"use client";
import { useActionState } from "react";
import { Card, Button, Toast } from "@/components/ui";

interface RetryActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

// D14-08 — the settings half of the resume-path program: `companies.settings.automation.
// approvalRetry.autoRetryCount` (0..3, 0 = manual only, D14-07's write path). Admin-gated by the
// PAGE (it only renders this component when `can(me, "company.manage", tenant)`), and the server
// action re-checks the same capability — belt and suspenders, matching `ActionButton`'s own pattern
// elsewhere on this page.
export function ApprovalRetryCard({
  tenantId,
  autoRetryCount,
  action,
}: {
  tenantId: string;
  autoRetryCount: number;
  action: (tenantId: string, prev: RetryActionState | null, formData: FormData) => Promise<RetryActionState>;
}) {
  const boundAction = action.bind(null, tenantId);
  const [state, formAction, pending] = useActionState(boundAction, null);

  return (
    <Card title="Approval retry">
      <p className="sys-empty-note" style={{ marginTop: 0 }}>
        How many times a FAILED automation write auto-retries before it needs a human to press
        Retry. 0 (default) means every failure waits for manual retry.
      </p>
      <form action={formAction} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ font: "500 12px var(--font-body)", color: "var(--ink-subtle)" }}>Auto-retry count</span>
          <select name="autoRetryCount" defaultValue={String(autoRetryCount)} disabled={pending}>
            <option value="0">0 — manual only</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </label>
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </form>
      {state?.error && <Toast message={state.error} />}
      {state?.ok && state.message && <Toast message={state.message} />}
    </Card>
  );
}
