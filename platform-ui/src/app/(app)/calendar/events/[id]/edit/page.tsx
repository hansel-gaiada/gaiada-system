import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import { getActiveTenant } from "@/lib/tenant";
import { listClients, listMembers, listProjects } from "@/lib/entities";
import { EVENT_NOT_FOUND, getEvent } from "@/lib/calendarEvents-data";
import { formInputOf } from "@/lib/calendarEvents";
import { eventUnitChoices } from "@/lib/deptCalendar";
import { readOrgRoot } from "@/lib/campaigns-data";
import { loadBusyExcludingEventAction, updateEventAction } from "@/lib/calendarEventsActions";
import { DISPLAY_TZ } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { EventForm } from "@/components/calendar/EventForm";

// DW-8g: edit an event (BFF §47.3 PATCH): the organizer and a company admin, which is the backend's `canEdit`. The form
// here is the schedule form with the event's values; "Record this meeting" is chosen when the event is made, so it is not offered.
// Busy times (§47.4) leave THIS event out (`excludeEventId`), so it never shows as busy against itself.
type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ company?: string }> };

export default async function EditEventPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { company } = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = company && accessibleCompanies(me).some((c) => c.id === company) ? company : await getActiveTenant(me);
  const back = tenant ? `/calendar/events/${encodeURIComponent(id)}?company=${encodeURIComponent(tenant)}` : "/calendar";
  const crumbs = [{ label: "Calendar", href: "/calendar" }, { label: "Event", href: back }, { label: "Edit" }];
  if (!tenant) {
    return (<><PageHeader title="Edit event" breadcrumbs={crumbs} /><EmptyNote>Select a company first.</EmptyNote></>);
  }

  const read = await getEvent(userId, tenant, id);
  if (read.kind !== "ok") {
    return (
      <>
        <PageHeader title="Edit event" breadcrumbs={crumbs} />
        {read.kind === "unavailable" && read.reason === EVENT_NOT_FOUND ? (
          <EmptyNote>{EVENT_NOT_FOUND}</EmptyNote>
        ) : (
          <ReadRefusal subject="this event" kind={read.kind} reason={read.kind === "unavailable" ? read.reason : undefined} />
        )}
      </>
    );
  }
  const ev = read.data;
  if (!ev.canEdit) {
    return (
      <>
        <PageHeader title="Edit event" breadcrumbs={crumbs} />
        <EmptyNote>{ev.status === "cancelled" ? "This event was cancelled, so it can't be changed." : "You can't change this event. Only its organizer or a company admin can."}</EmptyNote>
      </>
    );
  }

  const [members, clients, projects, root] = await Promise.all([
    listMembers(userId, ev.tenantId).then((m) => m, () => null),
    listClients(userId, ev.tenantId).then((c) => c, () => null),
    listProjects(userId, ev.tenantId).then((p) => p, () => null),
    readOrgRoot(me, ev.tenantId),
  ]);
  if (!members) {
    return (
      <>
        <PageHeader title="Edit event" breadcrumbs={crumbs} />
        <EmptyNote>This company&apos;s people couldn&apos;t be loaded, so the invitations can&apos;t be edited right now. Try again shortly.</EmptyNote>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Edit event" breadcrumbs={crumbs} />
      <Card>
        <EventForm
          mode="edit"
          initial={formInputOf(ev)}
          members={members.map((m) => ({ id: m.user_id, name: m.name }))}
          clients={(clients ?? []).map((c) => ({ id: c.id, name: c.name }))}
          projects={(projects ?? []).map((p) => ({ id: p.id, name: p.name, clientId: p.client_id }))}
          linksUnavailable={clients === null || projects === null}
          units={eventUnitChoices(me, root, ev.visibility === "department" ? ev.unitNodeId : null)}
          canRecord={false}
          hiddenPersonId={ev.organizer.id}
          viewerId={me.userId}
          zoneLabel={DISPLAY_TZ}
          save={updateEventAction.bind(null, ev.tenantId, ev.id)}
          loadBusy={loadBusyExcludingEventAction.bind(null, ev.tenantId, ev.id)}
          cancelHref={back}
        />
      </Card>
    </>
  );
}
