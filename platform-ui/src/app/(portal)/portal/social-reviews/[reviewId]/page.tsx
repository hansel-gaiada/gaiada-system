import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalSocialReview } from "@/lib/portal-data";
import { portalDate } from "@/lib/portal";
import { Card, Eyebrow } from "@/components/ui";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalLink, PortalPageHead, PortalSocialReviewStatus } from "@/components/portal/PortalBits";
import { PortalSocialReviewDecideForm } from "@/components/portal/PortalSocialReviewDecideForm";
import { PortalSocialReviewDecidedNote } from "@/components/portal/PortalSocialReviewDecidedNote";
import "@/components/pipeline/pipeline.css";

// SMM-32 — one drafted social post, in full: the exact preview the client is deciding against, plus
// the approve/request-changes decision itself.
//
// Ownership is not re-checked here beyond what `getPortalSocialReview` already resolves (the BFF's
// own `resolvePortalScope` + `client_id = ANY($1)` predicate on the list read this derives from) —
// a review outside the caller's own clients is indistinguishable from one that does not exist,
// deliberately (§16h/0075's existence-oracle rule), so `notFound()` is correct and complete.
//
// The decide form (`PortalSocialReviewDecideForm`) is rendered ONLY while `status === 'pending'` —
// once a decision is on file there is no second-decision affordance anywhere on this page, matching
// `PortalGateActions.tsx`'s own "a resolved gate offers no more buttons" rule.
export default async function PortalSocialReviewPage({ params }: { params: Promise<{ reviewId: string }> }) {
  const { reviewId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) notFound();

  const review = await getPortalSocialReview(userId, tenant, reviewId);
  if (!review) notFound();

  return (
    <>
      <PortalPageHead
        eyebrow="Your input"
        title={review.postTitle}
        actions={<PortalLive />}
      />

      <div className="cp-stack">
        <Card title="What's being asked" headerRight={<PortalSocialReviewStatus status={review.status} />}>
          <p style={{ margin: "0 0 8px", font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
            {review.network} · asked {portalDate(review.requestedAt)}
            {review.scheduledAt ? ` · scheduled to post ${portalDate(review.scheduledAt)}` : " · no schedule set yet"}
          </p>

          <Eyebrow style={{ display: "block", marginBottom: 6 }}>Post content</Eyebrow>
          <div style={{ padding: "10px 12px", background: "var(--wash)", borderRadius: 8, marginBottom: 12 }}>
            <p style={{ margin: 0, font: "400 14px/1.6 var(--font-body)", whiteSpace: "pre-wrap" }}>{review.body}</p>
          </div>

          {review.media.length > 0 && (
            <p style={{ margin: "0 0 12px", font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
              {review.media.length} attachment{review.media.length === 1 ? "" : "s"} on this post.
            </p>
          )}

          {review.status === "pending" && <PortalSocialReviewDecideForm reviewId={review.id} />}
          {/* The confirmation comes from the RECORDED decision, not only from the form's local state:
              deciding revalidates this page and the refreshed read unmounts the form above. */}
          {(review.status === "approved" || review.status === "changes_requested") && (
            <PortalSocialReviewDecidedNote status={review.status} />
          )}

          {review.status !== "pending" && review.comment && (
            <p style={{ margin: "12px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
              Your note: &ldquo;{review.comment}&rdquo;
            </p>
          )}
          {review.status !== "pending" && review.decidedAt && (
            <p style={{ margin: "4px 0 0", font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
              Decided {portalDate(review.decidedAt)}.
            </p>
          )}
        </Card>

        <PortalLink href="/portal/social-reviews">All post reviews</PortalLink>
      </div>
    </>
  );
}
