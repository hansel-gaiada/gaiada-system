import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listRecordings, STATUS_LABEL, DRIVE_LABEL, formatDuration } from "@/lib/meetings";
import { RecordControls } from "@/components/meetings/RecordControls";
import { Card, Eyebrow, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { formatDateTime } from "@/lib/format";

// WS11 capture edge — meeting-recordings registry. Record a client meeting (audio / audio+video), then
// every recording is referenceable by the team with its status, Drive state, and linked pipeline run.
// Degrades gracefully (empty states) until the backend is deployed / the capture helper is installed.
export default async function MeetingsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return <Card><EmptyNote>Select a company to see its meeting recordings.</EmptyNote></Card>;
  }
  const recordings = await listRecordings(userId, tenant);

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Meetings" }]} />
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Delivery</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Meeting Recordings</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 640 }}>
          Record a client meeting, transcribe it locally, and start the delivery pipeline — all from here.
          Recordings are saved on your machine first and synced to the company Drive so the whole team can reference them.
        </p>
      </div>

      <Card title="Record a meeting">
        <RecordControls />
      </Card>

      <div style={{ marginTop: 28 }}>
        <Card title="Recordings" headerRight={<span className="dash-pending-chip">{recordings.length}</span>}>
          {recordings.length === 0 ? (
            <EmptyNote>No recordings yet. Start one above — or register an externally-made recording.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Meeting" }, { label: "Kind" }, { label: "Status" }, { label: "Drive" }, { label: "Length" }, { label: "Recorded", align: "right" }]}
              rows={recordings.map((r) => [
                <Link key="t" href={`/meetings/${r.id}`} style={{ color: "inherit", fontWeight: 600 }}>
                  {r.title ?? r.meeting_id}
                </Link>,
                r.kind === "video" ? "🎥 A/V" : "🎙️ Audio",
                <StatusBadge key="s" label={STATUS_LABEL[r.status] ?? r.status} />,
                <StatusBadge key="d" label={DRIVE_LABEL[r.drive_status] ?? r.drive_status} />,
                formatDuration(r.duration_sec),
                formatDateTime(r.created_at),
              ])}
              tcols="2fr .8fr 1fr 1.1fr .8fr 1fr"
            />
          )}
        </Card>
      </div>
    </>
  );
}
