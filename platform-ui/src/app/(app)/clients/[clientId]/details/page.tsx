import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getClient, listDeliverables, listProjects } from "@/lib/entities";
import { listRecordings, STATUS_LABEL, formatDuration } from "@/lib/meetings";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { RecordControls } from "@/components/meetings/RecordControls";
import { ClientContactsPanel } from "@/components/clients/ClientContactsPanel";
import { ScheduleMeetingPanel } from "@/components/meetings/ScheduleMeetingPanel";
import { listClientContacts } from "@/lib/clientContacts";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDate, formatDateTime } from "@/lib/format";
import Link from "next/link";

type Params = Promise<{ clientId: string }>;

export default async function ClientDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const client = await getClient(userId, tenant, clientId);
  if (!client) notFound();
  const deliverables = (await listDeliverables(userId, tenant)).filter((d) => d.client_id === clientId);
  // WD-07 (Web Dev Phase 1 §12) — recordings scoped to this client, plus RecordControls with
  // clientId pre-filled: the client-workspace half of the capture-edge context plumbing.
  // AGN-3: these two are PANELS on a client page, not the page's subject, so a refusal is rendered
  // inline beside the rest of the client rather than taking the whole page down — but it IS rendered.
  // The panels are unwrapped here so the JSX below stays a straight list render; `refused` carries
  // the reason a panel is empty, which is exactly the distinction that was being lost.
  const meetingsResult = await listRecordings(userId, tenant, { clientId });
  const meetings = meetingsResult.kind === "ok" ? meetingsResult.data : [];
  const meetingsRefusal = meetingsResult.kind === "ok" ? null : meetingsResult;
  // W0-5 — the external half of engagement setup (D-3: the client is present BEFORE the first
  // meeting). Both reads degrade to [] rather than throwing, so one missing grant cannot take the
  // whole client page down.
  const contacts = await listClientContacts(userId, tenant, clientId);
  // W1 (D-3): what is coming up for this client, server-filtered to future scheduled rows.
  const upcomingResult = await listRecordings(userId, tenant, { clientId, scheduled: "upcoming" });
  const upcoming = upcomingResult.kind === "ok" ? upcomingResult.data : [];
  const upcomingRefusal = upcomingResult.kind === "ok" ? null : upcomingResult;
  // CC-1: filtered SERVER-side now that `/projects` takes `clientId`. This used to fetch every
  // project in the tenant and narrow in the browser, which stops being a filter past a page of rows.
  const clientProjects = (await listProjects(userId, tenant, clientId).catch(() => []))
    .map((p) => ({ id: p.id, name: p.name }));

  return (
    <>
      {/* CC-3: the hub LAYOUT now renders the client name, breadcrumbs and tab strip, so this tab
          renders only its own cards. The Delete action moved with the header — it is a destructive
          client-level action and belongs beside the client's identity, not inside one tab. */}
      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card title="Details">
          <DescriptionList items={[
            { label: "Status", value: <StatusBadge label={client.status} /> },
            { label: "Email", value: (client.contact as { email?: string })?.email ?? "—" },
          ]} />
        </Card>
        <Card title={`Deliverables${deliverables.length ? ` · ${deliverables.length}` : ""}`}>
          {deliverables.length === 0 ? (
            <EmptyNote>No deliverables for this client.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Deliverable" }, { label: "Status" }, { label: "Due", align: "right" }]}
              rows={deliverables.map((d) => [d.name, <StatusBadge key="s" label={d.status} />, formatDate(d.due_date)])}
              tcols="2fr 1fr 1fr"
            />
          )}
        </Card>
      </div>
      <div style={{ marginTop: 20 }}>
        <Card title={`Client access${contacts.length ? ` · ${contacts.length}` : ""}`}>
          <ClientContactsPanel
            clientId={clientId}
            clientName={client.name}
            contacts={contacts}
            projects={clientProjects}
          />
        </Card>
      </div>
      <div style={{ marginTop: 20 }}>
        <Card title={`Scheduled${upcoming.length ? ` · ${upcoming.length}` : ""}`}>
          {upcomingRefusal ? (
            <ReadRefusal
              subject="this client's scheduled meetings"
              kind={upcomingRefusal.kind}
              reason={upcomingRefusal.kind === "unavailable" ? upcomingRefusal.reason : undefined}
              inline
            />
          ) : null}
          <ScheduleMeetingPanel clientId={clientId} upcoming={upcoming} />
        </Card>
      </div>
      <div style={{ marginTop: 20 }}>
        <Card title={`Meetings${meetings.length ? ` · ${meetings.length}` : ""}`}>
          {meetingsRefusal ? (
            <ReadRefusal
              subject="this client's meetings"
              kind={meetingsRefusal.kind}
              reason={meetingsRefusal.kind === "unavailable" ? meetingsRefusal.reason : undefined}
              inline
            />
          ) : null}
          <RecordControls clientId={clientId} />
          {meetings.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <HairlineTable
                columns={[{ label: "Meeting" }, { label: "Status" }, { label: "Length" }, { label: "Recorded", align: "right" }]}
                rows={meetings.map((r) => [
                  <Link key="t" href={`/meetings/${r.id}`} style={{ color: "inherit", fontWeight: 600 }}>{r.title ?? r.meeting_id}</Link>,
                  <StatusBadge key="s" label={STATUS_LABEL[r.status] ?? r.status} />,
                  formatDuration(r.duration_sec),
                  formatDateTime(r.created_at),
                ])}
                tcols="2fr 1fr .8fr 1fr"
              />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
