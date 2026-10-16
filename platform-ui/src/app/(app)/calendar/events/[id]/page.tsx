import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import { getActiveTenant } from "@/lib/tenant";
import { EVENT_NOT_FOUND, getEvent } from "@/lib/calendarEvents-data";
import { RESPONSE_LABEL, describeWhen } from "@/lib/calendarEvents";
import { unitNameIn } from "@/lib/deptCalendar";
import { readOrgRoot } from "@/lib/campaigns-data";
import { cancelEventAction, respondEventAction } from "@/lib/calendarEventsActions";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { EventActions } from "@/components/calendar/EventActions";
import "@/components/calendar/calendar.css";

// DW-8g: one event (BFF §47.5). The company comes from `?company=` (the href the backend sends is
// `/calendar/events/<id>?company=<tenantId>`), checked against the caller's companies, else the active company. Which buttons
// show is the backend's `canEdit` / `canCancel` / `canRespond`, never a guess from a role.
type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ company?: string }> };

export default async function EventPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { company } = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = company && accessibleCompanies(me).some((c) => c.id === company) ? company : await getActiveTenant(me);
  const crumbs = [{ label: "Calendar", href: "/calendar" }, { label: "Event" }];
  if (!tenant) {
    return (<><PageHeader title="Event" breadcrumbs={crumbs} /><EmptyNote>Select a company first.</EmptyNote></>);
  }

  const read = await getEvent(userId, tenant, id);
  if (read.kind !== "ok") {
    return (
      <>
        <PageHeader title="Event" breadcrumbs={crumbs} />
        {read.kind === "unavailable" && read.reason === EVENT_NOT_FOUND ? (
          <EmptyNote>{EVENT_NOT_FOUND}</EmptyNote>
        ) : (
          <ReadRefusal subject="this event" kind={read.kind} reason={read.kind === "unavailable" ? read.reason : undefined} />
        )}
      </>
    );
  }
  const ev = read.data;
  const cancelled = ev.status === "cancelled";
  const companyName = me.companies.find((c) => c.id === ev.tenantId)?.name;
  const qs = `?company=${encodeURIComponent(ev.tenantId)}`;
  // A department event names its unit by id; the name comes from the org tree. A unit that has left the tree (or a tree that could
  // not be read) is still said, never left blank.
  const unitName = ev.visibility === "department" ? unitNameIn(await readOrgRoot(me, ev.tenantId), ev.unitNodeId) : null;
  const who = ev.visibility === "company" ? "Everyone in the company"
    : ev.visibility === "department" ? `Visible to ${unitName ?? "its department"}`
    : "Only the people invited";

  return (
    <>
      <PageHeader title={ev.title} breadcrumbs={[{ label: "Calendar", href: "/calendar" }, { label: ev.title }]} />
      <div className="cal-event">
        {cancelled && <p className="cal-event__banner" role="status">This event was cancelled.</p>}
        <Card>
          <dl className="cal-event__facts">
            <dt>When</dt><dd className={cancelled ? "cal-event__title--cancelled" : undefined}>{describeWhen(ev)}</dd>
            {ev.location && (<><dt>Place</dt><dd>{ev.location}</dd></>)}
            {ev.videoUrl && (<><dt>Video link</dt><dd><a href={ev.videoUrl} target="_blank" rel="noopener noreferrer">{ev.videoUrl}</a></dd></>)}
            <dt>Organizer</dt><dd>{ev.organizer.name || "Unknown"}</dd>
            {companyName && (<><dt>Company</dt><dd>{companyName}</dd></>)}
            {ev.client && (<><dt>Client</dt><dd>{ev.client.name}</dd></>)}
            {ev.project && (<><dt>Project</dt><dd>{ev.project.name}</dd></>)}
            <dt>Who can see it</dt><dd>{who}</dd>
            {ev.recording && (
              <>
                <dt>Recording</dt>
                <dd>
                  <Link href={`/meetings/${ev.recording.id}`}>Open the recording</Link> ({ev.recording.status}). Recordings are visible to everyone in the company.
                </dd>
              </>
            )}
            {ev.myResponse && (<><dt>Your answer</dt><dd>{RESPONSE_LABEL[ev.myResponse]}</dd></>)}
          </dl>
        </Card>

        <EventActions
          event={ev}
          editHref={`/calendar/events/${encodeURIComponent(ev.id)}/edit${qs}`}
          respond={respondEventAction.bind(null, ev.tenantId, ev.id)}
          cancel={cancelEventAction.bind(null, ev.tenantId, ev.id)}
        />

        {ev.description && (
          <Card title="Notes"><p className="cal-event__notes">{ev.description}</p></Card>
        )}

        <Card title={`Invited (${ev.attendeeCount})`}>
          <ul className="cal-event__people">
            {ev.attendees.map((a) => (
              <li key={a.userId} className="cal-event__person">
                <span>{a.name || "Former member"}{a.userId === ev.organizer.id ? " (organizer)" : ""}</span>
                <span className="cal-event__answer">{RESPONSE_LABEL[a.response]}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
