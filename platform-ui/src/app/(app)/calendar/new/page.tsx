import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listClients, listMembers, listProjects } from "@/lib/entities";
import { gateAllows } from "@/lib/workspaceAccess";
import { DISPLAY_TZ, todayIsoInDisplayZone } from "@/lib/format";
import { zoneTime } from "@/lib/zoneTime";
import { defaultFormInput } from "@/lib/calendarEvents";
import { createEventAction } from "@/lib/calendarEventsActions";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { EventForm } from "@/components/calendar/EventForm";

// DW-8g: schedule a meeting (BFF §47.5). The event is created in the ACTIVE company. The people to invite are that
// company's members (`GET /:t/members`). "Record this meeting" is offered only where the Meetings row is, the same gate the
// nav and the workspaces use. Busy times for the chosen people (§47.4) are not built, so none are shown.
export default async function NewEventPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const crumbs = [{ label: "Calendar", href: "/calendar" }, { label: "Schedule a meeting" }];
  if (!tenant) {
    return (<><PageHeader title="Schedule a meeting" breadcrumbs={crumbs} /><EmptyNote>Select a company first.</EmptyNote></>);
  }

  const [members, clients, projects] = await Promise.all([
    listMembers(userId, tenant).then((m) => m, () => null),
    listClients(userId, tenant).then((c) => c, () => null),
    listProjects(userId, tenant).then((p) => p, () => null),
  ]);
  if (!members) {
    return (
      <>
        <PageHeader title="Schedule a meeting" breadcrumbs={crumbs} />
        <EmptyNote>This company&apos;s people couldn&apos;t be loaded, so invitations aren&apos;t possible right now. Try again shortly.</EmptyNote>
      </>
    );
  }

  const canRecord = gateAllows({ kind: "agencyRow", row: "meetings" }, { me, tenantId: tenant, unitPath: [] });
  const initial = defaultFormInput(todayIsoInDisplayZone(), zoneTime(Date.now()));

  return (
    <>
      <PageHeader title="Schedule a meeting" breadcrumbs={crumbs} />
      <Card>
        <EventForm
          mode="create"
          initial={initial}
          members={members.map((m) => ({ id: m.user_id, name: m.name }))}
          clients={(clients ?? []).map((c) => ({ id: c.id, name: c.name }))}
          projects={(projects ?? []).map((p) => ({ id: p.id, name: p.name, clientId: p.client_id }))}
          linksUnavailable={clients === null || projects === null}
          canRecord={canRecord}
          hiddenPersonId={me.userId}
          zoneLabel={DISPLAY_TZ}
          save={createEventAction.bind(null, tenant)}
          cancelHref="/calendar"
        />
      </Card>
    </>
  );
}
