import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalTimeline } from "@/lib/portal-data";
import { clientStatus, portalDate, relativeDays, splitTimeline, statusTone, type PortalTimelineEvent } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead } from "@/components/portal/PortalBits";

// CP-10 — the whole relationship in one chronological stream.
//
// Two sections, not one list: WHAT'S COMING (dated commitments still ahead) and WHAT'S HAPPENED. The
// split is computed in `splitTimeline`, which puts an overdue `due` item into HISTORY rather than
// leaving it under "coming up" — an overdue milestone listed as upcoming reads as though it were still
// on schedule, which is the one thing a timeline must never imply.
//
// Events are composed by the BFF from client-visible OBJECTS (milestones, deliverables, the client's own
// decisions, contracts, invoices, confirmed payments) and never from the internal activity log. So
// nothing here can start leaking because someone added a new internal event type.
const KIND_WORD: Record<PortalTimelineEvent["kind"], string> = {
  milestone: "Milestone",
  deliverable: "Deliverable",
  decision: "Your decision",
  contract: "Agreement",
  invoice: "Invoice",
  payment: "Payment",
};

export default async function PortalTimelinePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const events = await getPortalTimeline(userId, tenant);
  const now = new Date();
  const { upcoming, history } = splitTimeline(events, now);

  return (
    <>
      <PortalPageHead
        eyebrow="Your account"
        title="Timeline"
        lead="Everything scheduled and everything that has happened, in one place."
        actions={<PortalLive topics={["projects", "deliverables", "invoices", "contracts", "approvals"]} />}
      />

      {events.length === 0 ? (
        <EmptyNote>Nothing on your timeline yet.</EmptyNote>
      ) : (
        <div className="cp-stack">
          <Card title="Coming up">
            {upcoming.length === 0 ? (
              <EmptyNote>Nothing dated ahead. We&apos;ll add dates here as they&apos;re agreed.</EmptyNote>
            ) : (
              <Stream events={upcoming} now={now} />
            )}
          </Card>
          <Card title="What&apos;s happened">
            {history.length === 0 ? <EmptyNote>Nothing yet.</EmptyNote> : <Stream events={history} now={now} />}
          </Card>
        </div>
      )}
    </>
  );
}

function Stream({ events, now }: { events: PortalTimelineEvent[]; now: Date }) {
  return (
    <div className="cp-tl">
      {events.map((e) => (
        <div className="cp-tl__row" key={`${e.kind}-${e.id}`}>
          <div className="cp-tl__when">
            {portalDate(e.at)}
            <div style={{ font: "400 11px/1.5 var(--font-body)", color: "var(--ink-faint)" }}>
              {relativeDays(e.at, now)}
            </div>
          </div>
          <div className="cp-tl__rail">
            {/* The dot's colour carries the item's state; the text beside it repeats that state in
                words, so the colour is decoration and never the only signal. */}
            <span className="cp-tl__dot" style={{ background: `var(--status-${statusTone(e.status)})` }} />
          </div>
          <div className="cp-tl__body">
            <div className="cp-tl__label">
              {e.projectId && (e.kind === "milestone" || e.kind === "deliverable") ? (
                <Link href={`/portal/projects/${e.projectId}`} style={{ color: "inherit", textDecoration: "none" }}>
                  {e.label}
                </Link>
              ) : e.kind === "contract" ? (
                <Link href={`/portal/contracts/${e.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                  {e.label}
                </Link>
              ) : e.kind === "invoice" ? (
                <Link href={`/portal/invoices/${e.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                  {e.label}
                </Link>
              ) : (
                e.label
              )}
            </div>
            <div className="cp-tl__meta">
              {KIND_WORD[e.kind]}
              {e.status && ` · ${clientStatus(e.status)}`}
              {e.context && ` · ${e.context}`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
