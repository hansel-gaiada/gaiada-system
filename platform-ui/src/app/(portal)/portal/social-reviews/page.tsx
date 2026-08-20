import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalSocialReviews } from "@/lib/portal-data";
import { portalDate, socialReviewStatusLabel } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead, PortalSocialReviewStatus } from "@/components/portal/PortalBits";
import "@/components/pipeline/pipeline.css";

// SMM-32 — "posts drafted for your brand, waiting on your sign-off" (D-16). Modelled directly on
// `/portal/approvals/page.tsx` (the closest existing analogue — a list of pending client decisions,
// most-needing-you first, with settled ones kept for the record below it).
//
// No `topics` filter on `PortalLive`: `portal-live.service.ts`'s `PortalTopic` union was never
// extended for this surface (see `lib/portal.ts`'s header on `PortalTopic`), so this page relies on
// the component's own unconditional idle poll rather than inventing an SSE topic nothing emits.
export default async function PortalSocialReviewsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const { reviews, isPortalClient } = await listPortalSocialReviews(userId, tenant);
  const pending = reviews.filter((r) => r.status === "pending");
  const decided = reviews.filter((r) => r.status !== "pending");

  return (
    <>
      <PortalPageHead
        eyebrow="Your input"
        title="Post reviews"
        lead={
          pending.length > 0
            ? "These posts are drafted for your brand and waiting on your sign-off before they go out."
            : "Nothing is waiting on your sign-off right now. Past decisions stay here for your records."
        }
        actions={<PortalLive />}
      />

      {reviews.length === 0 ? (
        isPortalClient ? (
          <EmptyNote>No posts have been sent for your review yet.</EmptyNote>
        ) : (
          <EmptyNote>
            This is the client-facing portal. You&apos;re signed in as a staff member, so there is no
            client account to review posts against. Ask/withdraw a client review from the Composer
            instead.
          </EmptyNote>
        )
      ) : (
        <div className="cp-stack">
          {pending.map((r) => (
            <Card key={r.id} title={r.postTitle} headerRight={<PortalSocialReviewStatus status={r.status} />}>
              <p style={{ margin: "0 0 8px", font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
                {r.network} · asked {portalDate(r.requestedAt)}
                {r.scheduledAt ? ` · scheduled ${portalDate(r.scheduledAt)}` : ""}
              </p>
              <p style={{ margin: "0 0 12px", font: "400 14px/1.5 var(--font-body)", whiteSpace: "pre-wrap" }}>{r.body}</p>
              <Link href={`/portal/social-reviews/${r.id}`} className="btn btn-primary" style={{ fontSize: 13, textDecoration: "none" }}>
                Review &amp; decide
              </Link>
            </Card>
          ))}

          {decided.length > 0 && (
            <Card title="Past reviews">
              <div style={{ display: "grid", gap: 8 }}>
                {decided.map((r) => (
                  <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", font: "400 13px var(--font-body)" }}>
                    <Link href={`/portal/social-reviews/${r.id}`} style={{ fontWeight: 500, color: "var(--erp-accent)", textDecoration: "none" }}>
                      {r.postTitle}
                    </Link>
                    <span style={{ color: "var(--ink-muted)" }}>{socialReviewStatusLabel(r.status)}</span>
                    <span style={{ color: "var(--ink-subtle)" }}>{r.decidedAt ? portalDate(r.decidedAt) : ""}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
