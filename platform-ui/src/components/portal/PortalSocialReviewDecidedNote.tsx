import { socialReviewStatusLabel, type SocialReviewStatus } from "@/lib/portal";

// SMM-32 — "your decision is recorded", in ONE place, rendered from two sides (the same split as
// `PortalSignedNote` for a contract signature):
//   * the review page (server) once the review is decided — the durable state. The decide action
//     revalidates that page, the refreshed read is no longer `pending`, and the page stops mounting
//     the decide form, so a confirmation held only in the form's `useActionState` state is unmounted
//     the moment the decision lands (Next 16.3 applies that refresh; 16.2 silently dropped it).
//   * `PortalSocialReviewDecideForm` (client), for the instant before the refreshed page arrives.
// No "use client" and no hooks: it renders on either side of the network.
export function PortalSocialReviewDecidedNote({ status }: {
  /** The recorded decision, from the server's read. Absent on the client-side path. */
  status?: Extract<SocialReviewStatus, "approved" | "changes_requested">;
}) {
  return (
    <div className="cp-form__ok" role="status">
      Thanks — your decision is recorded{status ? `: ${socialReviewStatusLabel(status).toLowerCase()}` : ""}.
    </div>
  );
}
