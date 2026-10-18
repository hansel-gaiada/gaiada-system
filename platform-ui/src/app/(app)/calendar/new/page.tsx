import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listClients, listMembers, listProjects } from "@/lib/entities";
import { gateAllows } from "@/lib/workspaceAccess";
import { DISPLAY_TZ, todayIsoInDisplayZone } from "@/lib/format";
import { zoneTime } from "@/lib/zoneTime";
import { defaultFormInput } from "@/lib/calendarEvents";
import { eventUnitChoices } from "@/lib/deptCalendar";
import { readOrgRoot } from "@/lib/campaigns-data";
import { createEventAction, loadBusyAction } from "@/lib/calendarEventsActions";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { EventForm } from "@/components/calendar/EventForm";

// DW-8g: schedule a meeting (BFF §47.5). The event is created in the ACTIVE company. The people to invite are that
// company's members (`GET /:t/members`). "Record this meeting" is offered only where the Meetings row is, the same gate the
// nav and the workspaces use. The chosen people's busy times for the picked day (§47.4, DW-D28) come from `loadBusyAction`.
// DW-10c-2/3 (§59.3, §59.4): "My department: <unit>" joins the visibility choices for the units the person is placed in or leads, and
// `?visibility=department&unit=<id>` (the department calendar's "Add an event") preselects that unit when it is among the choices.
type SearchParams = Promise<{ visibility?: string | string[]; unit?: string | string[] }>;
const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : v?.[0] ?? "");

export default async function NewEventPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const crumbs = [{ label: "Calendar", href: "/calendar" }, { label: "Schedule a meeting" }];
  if (!tenant) {
    return (<><PageHeader title="Schedule a meeting" breadcrumbs={crumbs} /><EmptyNote>Select a company first.</EmptyNote></>);
  }

  const [members, clients, projects, root] = await Promise.all([
    listMembers(userId, tenant).then((m) => m, () => null),
    listClients(userId, tenant).then((c) => c, () => null),
    listProjects(userId, tenant).then((p) => p, () => null),
    readOrgRoot(me, tenant),
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
  const requestedUnit = one(sp.visibility) === "department" ? one(sp.unit) : "";
  const units = eventUnitChoices(me, tenant, root, requestedUnit || null);
  const base = defaultFormInput(todayIsoInDisplayZone(), zoneTime(Date.now()));
  const initial = requestedUnit && units.some((u) => u.id === requestedUnit) ? { ...base, visibility: "department" as const, unitNodeId: requestedUnit } : base;

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
          units={units}
          canRecord={canRecord}
          hiddenPersonId={me.userId}
          viewerId={me.userId}
          zoneLabel={DISPLAY_TZ}
          save={createEventAction.bind(null, tenant)}
          loadBusy={loadBusyAction.bind(null, tenant)}
          cancelHref="/calendar"
        />
      </Card>
    </>
  );
}
