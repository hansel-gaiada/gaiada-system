import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listRecordings, STATUS_LABEL, DRIVE_LABEL, formatDuration, type RecordingStatus } from "@/lib/meetings";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { listPipelineRuns } from "@/lib/pipeline";
import { listClients, listProjects } from "@/lib/entities";
import { RecordControls } from "@/components/meetings/RecordControls";
import { Card, Eyebrow, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { formatDateTime } from "@/lib/format";

const RECORDING_STATUSES = Object.keys(STATUS_LABEL) as RecordingStatus[];

// Next 15: searchParams is async.
type SP = Promise<{ status?: string; clientId?: string; projectId?: string }>;

// WS11 capture edge — meeting-recordings registry. Record a client meeting (audio / audio+video), then
// every recording is referenceable by the team with its status, Drive state, and linked pipeline run.
// Degrades gracefully (empty states) until the backend is deployed / the capture helper is installed.
export default async function MeetingsPage({ searchParams }: { searchParams: SP }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return <EmptyNote>Select a company to see its meeting recordings.</EmptyNote>;
  }
  const { status, clientId, projectId } = await searchParams;

  // C2: `listRecordings` has taken status/clientId/projectId since it was written
  // (lib/meetings.ts:82-90) — this page just never passed them through. Client/project dropdowns
  // are populated from the existing entity lists (already fetched elsewhere in the app; no new
  // backend call shape).
  const [recordingsResult, clients, projects] = await Promise.all([
    listRecordings(userId, tenant, { status: status || undefined, clientId: clientId || undefined, projectId: projectId || undefined }),
    listClients(userId, tenant),
    listProjects(userId, tenant).catch(() => []),
  ]);
  // AGN-3: the registry is this page's whole subject, so a refusal takes the page rather than
  // rendering an empty table that asserts "no recordings" on the strength of a denial.
  if (recordingsResult.kind === "forbidden") {
    return <ReadRefusal subject="the meeting registry for this company" kind="forbidden" />;
  }
  if (recordingsResult.kind === "unavailable") {
    return <ReadRefusal subject="The meeting registry" kind="unavailable" reason={recordingsResult.reason} />;
  }
  const recordings = recordingsResult.data;
  // WD-07: run-status chips — the recording's own status only says "in pipeline"; resolve the
  // linked run's actual delivery status too, so the registry answers "what's happening with it
  // now" without a click-through. Cheap: one extra list call, not per-row.
  // AGN-3: run statuses ENRICH the registry rows (a chip); the recordings themselves are the
  // subject and are already guarded above. A refusal here costs the chip, not the page — see the
  // note in pipeline/page.tsx on why every unwrap is documented rather than silent.
  const runs = recordings.some((r) => r.pipeline_run_id)
    ? await listPipelineRuns(userId, tenant).then((r) => (r.kind === "ok" ? r.data : []))
    : [];
  const runStatusById = new Map(runs.map((r) => [r.id, r.status]));

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Meetings" }]} />
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Delivery</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Meeting Recordings</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "var(--ink-muted)", maxWidth: 640 }}>
          Record a client meeting, transcribe it locally, and start the delivery pipeline — all from here.
          Recordings are saved on your machine first and synced to the company Drive so the whole team can reference them.
        </p>
      </div>

      <Card title="Record a meeting">
        <RecordControls />
      </Card>

      <div style={{ marginTop: 28 }}>
        <Card style={{ marginBottom: 20 }}>
          <form className="lux-filters" method="get" aria-label="Recording filters">
            <label className="lux-filters__field">
              <span>Status</span>
              <select name="status" defaultValue={status ?? ""}>
                <option value="">All</option>
                {RECORDING_STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
            </label>
            <label className="lux-filters__field">
              <span>Client</span>
              <select name="clientId" defaultValue={clientId ?? ""}>
                <option value="">All</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="lux-filters__field">
              <span>Project</span>
              <select name="projectId" defaultValue={projectId ?? ""}>
                <option value="">All</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <div className="lux-filters__actions">
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
              <a href="/meetings" className="lux-btn lux-btn--ghost lux-btn--sm">Reset</a>
            </div>
          </form>
        </Card>

        <Card title="Recordings" headerRight={<span className="dash-pending-chip">{recordings.length}</span>}>
          {recordings.length === 0 ? (
            <EmptyNote>{status || clientId || projectId ? "No recordings match these filters." : "No recordings yet. Start one above — or register an externally-made recording."}</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Meeting" }, { label: "Kind" }, { label: "Status" }, { label: "Run" }, { label: "Drive" }, { label: "Length" }, { label: "Recorded", align: "right" }]}
              rows={recordings.map((r) => [
                <Link key="t" href={`/meetings/${r.id}`} style={{ color: "inherit", fontWeight: 600 }}>
                  {r.title ?? r.meeting_id}
                </Link>,
                r.kind === "video" ? "🎥 A/V" : "🎙️ Audio",
                <StatusBadge key="s" label={STATUS_LABEL[r.status] ?? r.status} />,
                r.pipeline_run_id ? (
                  <Link key="r" href={`/pipeline/${r.pipeline_run_id}`} style={{ color: "inherit" }}>
                    <StatusBadge label={(runStatusById.get(r.pipeline_run_id) ?? "unknown").replace(/_/g, " ")} />
                  </Link>
                ) : (
                  <span key="r" style={{ font: "400 13px var(--font-body)", color: "var(--ink-faint)" }}>—</span>
                ),
                <StatusBadge key="d" label={DRIVE_LABEL[r.drive_status] ?? r.drive_status} />,
                formatDuration(r.duration_sec),
                formatDateTime(r.created_at),
              ])}
              tcols="1.8fr .7fr .9fr 1fr 1fr .8fr 1fr"
            />
          )}
        </Card>
      </div>
    </>
  );
}
