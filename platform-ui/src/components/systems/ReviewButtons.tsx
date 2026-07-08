"use client";
import { useActionState } from "react";
import type { ReviewActionState } from "@/app/(app)/knowledge/actions";
import { Button, Toast } from "@/components/ui";

// Two small independent forms (approve/reject), each bound ahead of time by
// the caller to a specific source id + decision. Kept intentionally tiny —
// the server action already degrades gracefully when the backend endpoint
// isn't wired up yet, so this component only needs to surface the result.
export function ReviewButtons({
  approveAction,
  rejectAction,
}: {
  approveAction: (prev: ReviewActionState | null, formData: FormData) => Promise<ReviewActionState>;
  rejectAction: (prev: ReviewActionState | null, formData: FormData) => Promise<ReviewActionState>;
}) {
  const [approveState, approveFormAction, approvePending] = useActionState(approveAction, null);
  const [rejectState, rejectFormAction, rejectPending] = useActionState(rejectAction, null);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <form action={approveFormAction}>
        <Button type="submit" variant="solid" size="sm" disabled={approvePending || rejectPending}>
          {approvePending ? "Approving…" : "Approve"}
        </Button>
      </form>
      <form action={rejectFormAction}>
        <Button type="submit" variant="ghost" size="sm" disabled={approvePending || rejectPending}>
          {rejectPending ? "Rejecting…" : "Reject"}
        </Button>
      </form>
      {approveState?.error && <Toast message={approveState.error} />}
      {approveState?.ok && <Toast message="Approved." />}
      {rejectState?.error && <Toast message={rejectState.error} />}
      {rejectState?.ok && <Toast message="Rejected." />}
    </div>
  );
}
