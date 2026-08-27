import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment } from "@/lib/departments";
import { deptTabs, toolkitFor } from "@/lib/deptToolkits";
import { getPipelineRun, listPipelineRuns, type PipelineGate, type PipelineRun } from "@/lib/pipeline";
import { listRecordings, type MeetingRecording } from "@/lib/meetings";
import { listClients, listProjects } from "@/lib/entities";
import { ingestAction, retryAudioAction, setTranscriptAction, uploadAudioAction } from "@/lib/meetingsActions";
import { createBriefingAction, startRunManuallyAction } from "@/lib/prdActions";
import { decideGateAction } from "@/lib/pipelineActions";
import { flowCounts, orderBriefings, scopeToDepartment } from "@/lib/prdFlow";
import { PrdFlowHeader } from "@/components/prd/PrdFlowHeader";
import { BriefingComposer } from "@/components/prd/BriefingComposer";
import { BriefingCard } from "@/components/prd/BriefingCard";
import { RunApprovalRow } from "@/components/prd/RunApprovalRow";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";

type Params = Promise<{ deptId: string }>;

// How many active runs get their gates read (one `getPipelineRun` each — the list endpoint carries no
// gates). Beyond this the row still renders, but says "open the run to see its approvals" rather than
// guessing. A list-with-gates read on the backend would remove the cap; tracked as a frontend gap.
const GATE_DETAIL_CAP = 12;

// PRD Studio — one flow, four beats: create a briefing → add its recording → convert the transcript
// into a PRD run → clear GM review and client sign-off. Every state shown comes from a field the
// backend already returns (meeting_recordings.status, pipeline_gates); see lib/prdFlow.ts.
//
// This is a WEB DEV tab. The route is the generic `/departments/[deptId]/prd`, so two things hold it
// to that: the page 404s for any department whose toolkit has no `prd` tab, and everything it lists
// is scoped to this department's projects (`scopeToDepartment`) — recordings and runs are tenant-wide
// on the backend and an SEO scope call must not show up as a Web Dev briefing.
export default async function PrdStudioPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  if (!deptTabs(toolkitFor(dept.name)).some((t) => t.key === "prd")) notFound();

  // AGN-3: the run list is this page's subject, so a refusal is stated rather than rendered as an
  // empty list — "nothing produced" and "you may not see it" are different claims.
  const runsResult = await listPipelineRuns(userId, tenant);
  if (runsResult.kind === "forbidden") return <ReadRefusal subject="this department's delivery runs" kind="forbidden" />;
  if (runsResult.kind === "unavailable") return <ReadRefusal subject="This department's delivery runs" kind="unavailable" reason={runsResult.reason} />;
  const allRuns = runsResult.data;

  const [recordingsResult, clients, projects] = await Promise.all([
    listRecordings(userId, tenant),
    listClients(userId, tenant),
    listProjects(userId, tenant).catch(() => []),
  ]);
  const allRecordings: MeetingRecording[] = recordingsResult.kind === "ok" ? recordingsResult.data : [];
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const recordingByMeetingId = new Map(allRecordings.map((r) => [r.meeting_id, r]));

  // Web Dev only: this department's projects decide what belongs on this tab.
  const deptProjects = projects.filter((p) => p.department_id === deptId);
  const { recordings, runs } = scopeToDepartment(deptId, new Set(deptProjects.map((p) => p.id)), allRecordings, allRuns);

  // Gates for the active runs — the approval chips need them; the list read does not carry them.
  const activeRuns = runs.filter((r) => r.status !== "complete");
  const doneRuns = runs.filter((r) => r.status === "complete");
  const detailed = activeRuns.slice(0, GATE_DETAIL_CAP);
  const details = await Promise.all(detailed.map((r) => getPipelineRun(userId, tenant, r.id)));
  const gatesByRun = new Map<string, PipelineGate[] | null>();
  detailed.forEach((r, i) => {
    const d = details[i];
    gatesByRun.set(r.id, d.kind === "ok" && d.data ? d.data.gates : null);
  });

  // Action order, converted ones lingering briefly — see lib/prdFlow.ts::orderBriefings.
  const briefings = orderBriefings(recordings, Date.now());

  const counts = flowCounts(
    recordings,
    runs.map((run) => ({ run, gates: gatesByRun.get(run.id) ?? [] })),
  );

  const mayDecide = can(me, "approvals.decide", tenant);
  const prdPath = `/departments/${deptId}/prd`;
  async function onDecide(formData: FormData) {
    "use server";
    await decideGateAction(formData);
    revalidatePath(prdPath);
  }

  const renderRun = (run: PipelineRun) => {
    const rec = run.source_meeting_id ? recordingByMeetingId.get(run.source_meeting_id) : undefined;
    return (
      <RunApprovalRow
        key={run.id}
        run={run}
        gates={gatesByRun.has(run.id) ? gatesByRun.get(run.id)! : run.status === "complete" ? [] : null}
        briefingHref={rec ? `/meetings/${rec.id}` : null}
        briefingTitle={rec?.title ?? null}
        mayDecide={mayDecide}
        onDecide={onDecide}
      />
    );
  };

  return (
    <>
      <PrdFlowHeader counts={counts} />

      <Card title="Start here — create a briefing">
        <BriefingComposer
          clients={clients.map((c) => ({ id: c.id, name: c.name }))}
          projects={deptProjects.map((p) => ({ id: p.id, name: p.name, client_id: p.client_id }))}
          departmentId={deptId}
          departmentName={dept.name}
          action={createBriefingAction}
        />
      </Card>

      <div style={{ marginTop: 28 }}>
        <Card
          title={briefings.length > 0 ? `Briefings in progress (${briefings.length})` : "Briefings in progress"}
          headerRight={<Link href="/meetings" className="lux-btn lux-btn--ghost lux-btn--sm">All meetings →</Link>}
        >
          {recordingsResult.kind !== "ok" ? (
            <ReadRefusal subject="this department's briefings" kind={recordingsResult.kind} reason={recordingsResult.kind === "unavailable" ? recordingsResult.reason : undefined} />
          ) : briefings.length === 0 ? (
            <EmptyNote>No {dept.name} briefings waiting. Create one above — it appears here with its next step.</EmptyNote>
          ) : (
            <div className="prd-briefings">
              {briefings.map((r) => (
                <BriefingCard
                  key={r.id}
                  recording={r}
                  clientName={r.client_id ? clientName.get(r.client_id) ?? null : null}
                  projectName={r.project_id ? projectName.get(r.project_id) ?? null : null}
                  actions={{ upload: uploadAudioAction, retry: retryAudioAction, setTranscript: setTranscriptAction, ingest: ingestAction, startRunManually: startRunManuallyAction }}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 28 }}>
        <Card
          title="PRD runs — approvals"
          headerRight={<Link href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Open pipeline →</Link>}
        >
          {runs.length === 0 ? (
            <EmptyNote>No {dept.name} PRD runs yet. Convert a transcribed briefing above and its approvals appear here.</EmptyNote>
          ) : (
            <>
              {activeRuns.length === 0 ? (
                <EmptyNote>Nothing waiting for approval. Every run is complete.</EmptyNote>
              ) : (
                <div className="prd-runs">{activeRuns.map(renderRun)}</div>
              )}
              {doneRuns.length > 0 && (
                <details className="prd-done">
                  <summary className="prd-done__summary">Done ({doneRuns.length})</summary>
                  <div className="prd-runs">{doneRuns.map(renderRun)}</div>
                </details>
              )}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
