import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPipelineRuns } from "@/lib/pipeline";
import { RecordControls } from "@/components/meetings/RecordControls";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDateTime } from "@/lib/format";

type Params = Promise<{ deptId: string }>;

// PRD Studio — requirements capture → PRD. Records a client/stakeholder briefing
// through the WS11 capture edge (local-first: saved + transcribed on the machine,
// only the transcript enters the pipeline), which the delivery pipeline turns into
// a PRD across its three tracks. This tab is the Web Dev entry point onto that flow.
export default async function PrdStudioPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const runs = await listPipelineRuns(userId, tenant);

  return (
    <>
      <Card title="Capture a requirements briefing">
        <p style={{ margin: "0 0 14px", font: "400 13px/1.5 var(--font-body)", color: "var(--erp-ink-50)", maxWidth: 620 }}>
          Record the client or stakeholder session. It is transcribed locally, then the delivery
          pipeline drafts the PRD (and the report & scope tracks) from the transcript — you review
          and sign off the PRD gate before it goes further.
        </p>
        <RecordControls />
      </Card>

      <div style={{ marginTop: 28 }}>
        <Card
          title="PRD runs"
          headerRight={<Link href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Open pipeline →</Link>}
        >
          {runs.length === 0 ? (
            <EmptyNote>No PRD runs yet. Record a briefing above — a run appears here once the meeting is dispatched into the pipeline.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Run" }, { label: "Source meeting" }, { label: "Status" }, { label: "Started", align: "right" }]}
              tcols="2fr 1.3fr 1fr 1fr"
              rows={runs.map((r) => [
                r.title ?? "(untitled)",
                r.source_meeting_id ?? "—",
                <StatusBadge key="s" label={r.status.replace(/_/g, " ")} />,
                formatDateTime(r.created_at),
              ])}
            />
          )}
        </Card>
      </div>
    </>
  );
}
