import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalTimeline, listPortalProjects } from "@/lib/portal-data";
import { splitTimeline } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalProjectRanges, PortalTimelineStream } from "@/components/portal/PortalTimelineRows";

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

export default async function PortalTimelinePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  // P4-K2: the project range + urgency tier crossing into the portal, per the K1 client-safe
  // projection (project authored range · progress % · milestone state · urgency tier — never ball
  // history, internal status labels, staff names or task titles). `listPortalProjects` already
  // returns `startDate`/`dueDate`/`progressPercent`; nothing new to fetch, only to render.
  const [events, projects] = await Promise.all([
    getPortalTimeline(userId, tenant),
    listPortalProjects(userId, tenant),
  ]);
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

      {projects.length > 0 && (
        <Card title="Your projects">
          <PortalProjectRanges projects={projects} now={now} />
        </Card>
      )}

      {events.length === 0 ? (
        <EmptyNote>Nothing on your timeline yet.</EmptyNote>
      ) : (
        <div className="cp-stack">
          <Card title="Coming up">
            {upcoming.length === 0 ? (
              <EmptyNote>Nothing dated ahead. We&apos;ll add dates here as they&apos;re agreed.</EmptyNote>
            ) : (
              <PortalTimelineStream events={upcoming} now={now} />
            )}
          </Card>
          <Card title="What&apos;s happened">
            {history.length === 0 ? <EmptyNote>Nothing yet.</EmptyNote> : <PortalTimelineStream events={history} now={now} />}
          </Card>
        </div>
      )}
    </>
  );
}
