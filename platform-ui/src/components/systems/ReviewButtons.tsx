"use client";
import { useActionState } from "react";
import type { ReviewActionState } from "@/app/(app)/knowledge/actions";
import { Button, Toast } from "@/components/ui";
import { useOutcomePost } from "@/components/OutcomeScope";

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
  // A review revalidates /knowledge and the source leaves the quarantine list, so this row unmounts
  // when the refresh lands (Next 16.3 applies it right after the action). Inside an OutcomeScope the
  // success is posted to the scope instead of rendered here; refusals keep the row and stay local.
  const post = useOutcomePost();
  const confirmed = (
    action: typeof approveAction,
    message: string,
  ) => async (prev: ReviewActionState | null, formData: FormData): Promise<ReviewActionState> => {
    const result = await action(prev, formData);
    if (result.ok) post?.(message);
    return result;
  };
  const [approveState, approveFormAction, approvePending] = useActionState(confirmed(approveAction, "Approved."), null);
  const [rejectState, rejectFormAction, rejectPending] = useActionState(confirmed(rejectAction, "Rejected."), null);

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
      {approveState?.ok && !post && <Toast message="Approved." />}
      {rejectState?.error && <Toast message={rejectState.error} />}
      {rejectState?.ok && !post && <Toast message="Rejected." />}
    </div>
  );
}
