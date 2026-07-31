import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import {
  getPipelineRun,
  listInternalPendingGates,
  GATE_LABEL,
  TRACK_LABEL,
  TRACK_ORDER,
  groupStagesByTrack,
  describeBlockage,
  humanizeStageName,
  isStageLocked,
  type PipelineGate,
  type PipelineStage,
} from "@/lib/pipeline";
import { decideGateAction, editStageArtifactAction } from "@/lib/pipelineActions";
import { findRecordingByMeetingId } from "@/lib/meetings";
import { getClient } from "@/lib/entities";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import { formatDateTime } from "@/lib/format";
import "@/components/pipeline/pipeline.css";

// WD-02 (Web Dev Phase 1) — the per-run delivery-pipeline workspace. Drills one row of `/pipeline`
// into its full picture: the three tracks (delivery/report/scope) with their stage chips and
// rendered artifacts, the gate history + whichever beat is currently pending, a plain-language
// blockage line, and the meeting <-> run <-> portal links. Deep-linked from /meetings/[id] (once a
// recording is ingested) and from the PRD Studio tab; the list page (`/pipeline`) also links each
// row in here. Degrades like every WS11 surface: a 404/403 run read notFound()s, a missing meeting
// or client renders a plain teach-state instead of a broken link.
export default async function PipelineRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/pipeline");

  const run = await getPipelineRun(userId, tenant, runId);
  if (!run) notFound();

  const mayDecide = can(me, "approvals.decide", tenant);
  // WD-03 (D-3): the SAME elevated capability gates artifact edit mode (mirrors the backend Cerbos
  // policy — pipeline_stage.update now excludes plain "member"). The backend's 409 on a signed
  // stage remains the real lock; isStageLocked here only decides whether to SHOW the edit form.
  const mayEditArtifact = mayDecide;
  const { text: blockageText } = describeBlockage(run, run.gates);
  const byTrack = groupStagesByTrack(run.stages);

  // Meeting link: source_meeting_id is the dispatcher's meetingId, not a recording row id — resolve
  // it against the registry (see findRecordingByMeetingId's doc comment for why there's no direct read).
  const recording = run.source_meeting_id ? await findRecordingByMeetingId(userId, tenant, run.source_meeting_id) : null;

  // Client / portal link. KNOWN GAP (tracked, not fixed here): the n8n dispatcher currently drops
  // client context on ingest, so client_id lands NULL on most runs — render a teach-state instead
  // of a broken link when that's the case, rather than assuming every run has one.
  const client = run.client_id ? await getClient(userId, tenant, run.client_id) : null;

  async function onDecide(formData: FormData) {
    "use server";
    await decideGateAction(formData);
  }

  async function onEditArtifact(formData: FormData) {
    "use server";
    await editStageArtifactAction(formData);
  }

  return (
    <>
      <div style={{ marginBottom: 22 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Delivery Pipeline", href: "/pipeline" }, { label: run.title ?? "Untitled run" }]} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Eyebrow style={{ color: "var(--erp-accent)" }}>Run</Eyebrow>
          <StatusBadge label={run.status.replace(/_/g, " ")} />
        </div>
        <h1 style={{ margin: "6px 0 0", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 30, lineHeight: 1.1 }}>
          {run.title ?? "Untitled run"}
        </h1>
        <p style={{ margin: "8px 0 0", font: "400 13px var(--font-body)", color: "var(--ink-subtle)" }}>
          Started {formatDateTime(run.created_at)} · last updated {formatDateTime(run.updated_at)}
        </p>
      </div>

      <div className="pl-blockage">{blockageText}</div>

      <div style={{ display: "grid", gap: 22, gridTemplateColumns: "minmax(0,1fr)" }}>
        <Card title="Links">
          <div className="pl-link-row">
            <div className="pl-link-row__item">
              {run.source_meeting_id ? (
                recording ? (
                  <>Source meeting: <Link href={`/meetings/${recording.id}`}>{recording.title ?? recording.meeting_id}</Link></>
                ) : (
                  <>Source meeting: {run.source_meeting_id} (not found in the recordings registry)</>
                )
              ) : (
                <>No source meeting linked — this run was created directly.</>
              )}
            </div>
            <div className="pl-link-row__item">
              {run.client_id ? (
                client ? (
                  <>Client: <strong>{client.name}</strong> — tracked in their project portal (client-only access; not viewable from here)</>
                ) : (
                  <>Client: unavailable (id {run.client_id} not found — check the company&apos;s client list)</>
                )
              ) : (
                <>No client is linked to this run yet, so it won&apos;t appear in any client portal. This is set from the meeting the run
                {" "}started from; a run created before that link existed backfills once re-ingested.</>
              )}
            </div>
          </div>
        </Card>

        <Card title="Gates">
          {run.gates.length === 0 ? (
            <EmptyNote>No gates opened yet.</EmptyNote>
          ) : (
            <div>
              {run.gates.map((g) => (
                <GateRow key={g.id} gate={g} runId={run.id} mayDecide={mayDecide} onDecide={onDecide} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Tracks">
          <div style={{ display: "grid", gap: 26, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            {TRACK_ORDER.map((track) => {
              const stages = byTrack[track];
              return (
                <div key={track}>
                  <Eyebrow style={{ display: "block", marginBottom: 10 }}>{TRACK_LABEL[track]}</Eyebrow>
                  {stages.length === 0 ? (
                    <EmptyNote>No stages yet.</EmptyNote>
                  ) : (
                    <>
                      <div className="pl-chip-row">
                        {stages.map((s) => (
                          <span key={s.id} className={`pl-chip${s.status === "done" ? " pl-chip--done" : s.status === "failed" ? " pl-chip--failed" : ""}`}>
                            {humanizeStageName(s.name)} · {s.status.replace(/_/g, " ")}
                            {s.confidence != null && <span className="pl-chip__confidence"> · {Math.round(s.confidence * 100)}%</span>}
                          </span>
                        ))}
                      </div>
                      {stages.map((s) => (
                        <StageBlock key={s.id} stage={s} runId={run.id} locked={isStageLocked(s, run.gates)} mayEdit={mayEditArtifact} onEdit={onEditArtifact} />
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}

// WD-03 (D-3) — one stage's artifact block: the rendered markdown, a "locked" badge once the
// client sign gate for this track is decided, and (elevated + not locked) a collapsible edit form.
// Plain <details>/<form> — no client JS, matching this page's server-only rendering.
function StageBlock({ stage, runId, locked, mayEdit, onEdit }: {
  stage: PipelineStage;
  runId: string;
  locked: boolean;
  mayEdit: boolean;
  onEdit: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="pl-stage">
      <div className="pl-stage__head">
        <span className="pl-stage__name">{humanizeStageName(stage.name)}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {locked && <StatusBadge label="locked — client signed" />}
          <span className="pl-stage__meta">updated {formatDateTime(stage.updated_at)}</span>
        </div>
      </div>
      {stage.artifact_ref ? (
        <ArtifactMarkdown text={stage.artifact_ref} />
      ) : (
        <EmptyNote>No artifact for this stage yet.</EmptyNote>
      )}
      {mayEdit && !locked && (
        <details className="pl-edit">
          <summary className="pl-edit__summary">Edit artifact</summary>
          <form action={onEdit} className="pl-edit__form">
            <input type="hidden" name="stageId" value={stage.id} />
            <input type="hidden" name="runId" value={runId} />
            <textarea name="artifactRef" defaultValue={stage.artifact_ref ?? ""} rows={10} className="pl-edit__textarea" />
            <button type="submit" className="btn btn-primary" style={{ fontSize: 13, alignSelf: "flex-start" }}>Save</button>
          </form>
        </details>
      )}
      {locked && (
        <p className="pl-edit__locked-note">
          What the client signed can&apos;t be edited — this keeps the record matching what they agreed to.
        </p>
      )}
    </div>
  );
}

function GateRow({ gate, runId, mayDecide, onDecide }: {
  gate: PipelineGate;
  runId: string;
  mayDecide: boolean;
  onDecide: (formData: FormData) => Promise<void>;
}) {
  const canDecideThis = mayDecide && gate.status === "pending" && gate.actor_side === "internal";
  return (
    <div className="pl-gate-row">
      <div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>
          {GATE_LABEL[gate.kind] ?? gate.kind}
          <span style={{ marginLeft: 8 }}><StatusBadge label={gate.actor_side === "client" ? "client" : "internal"} /></span>
        </div>
        <div style={{ font: "400 13px/1.4 var(--font-body)", color: "var(--ink-subtle)" }}>
          {gate.status === "pending"
            ? `Opened ${formatDateTime(gate.created_at)}`
            : `${gate.decision ?? "decided"} ${gate.decided_at ? `· ${formatDateTime(gate.decided_at)}` : ""}`}
          {gate.note ? ` · ${gate.note}` : ""}
        </div>
      </div>
      {canDecideThis ? (
        <form action={onDecide} style={{ display: "flex", gap: 8 }}>
          <input type="hidden" name="gateId" value={gate.id} />
          <input type="hidden" name="runId" value={runId} />
          <button type="submit" name="decision" value="approved" className="btn btn-primary" style={{ fontSize: 13 }}>Approve</button>
          <button type="submit" name="decision" value="changes_requested" className="btn" style={{ fontSize: 13 }}>Request changes</button>
        </form>
      ) : gate.status === "pending" ? (
        <StatusBadge label={gate.actor_side === "client" ? "waiting on client" : "review pending"} />
      ) : (
        <StatusBadge label={gate.decision ?? "decided"} />
      )}
    </div>
  );
}
