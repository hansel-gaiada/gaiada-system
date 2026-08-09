import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import {
  getPipelineRun,
  listInternalPendingGates,
  GATE_LABEL,
  TRACK_LABEL,
  TRACK_ORDER,
  RUN_STATUSES,
  ACTOR_SIDES,
  ALL_GATE_KINDS,
  SCOPE_PARTIES,
  SCOPE_PARTY_LABEL,
  groupStagesByTrack,
  describeBlockage,
  summarizeScopeSignoffs,
  humanizeStageName,
  isStageLocked,
  type PipelineGate,
  type PipelineStage,
  type PipelineRunDetail,
} from "@/lib/pipeline";
import {
  decideGateAction,
  editStageArtifactAction,
  recordScopeSignoffAction,
  updateRunStatusAction,
  createStageAction,
  openGateAction,
} from "@/lib/pipelineActions";
import { findRecordingByMeetingId } from "@/lib/meetings";
import { getClient, getProject } from "@/lib/entities";
import { listProvisionedSitesForRun } from "@/lib/webdevProvisionedSites-data";
import { provisionSiteAction, reconcileSiteAction } from "@/lib/webdevProvisionedSitesActions";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import { SiteRepoCard, type SiteListState } from "@/components/pipeline/SiteRepoCard";
import { MailThreadPanel } from "@/components/mail/MailThreadPanel";
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

  // Client / portal link. The gap this used to warn about is FIXED (WD-30): createRun now derives
  // client_id from the source meeting, and migration 0074 backfilled the runs written before it, so
  // client_id is normally present. The null branch below stays — a run created directly, with no source
  // meeting, legitimately has no client, and that is worth saying rather than assuming.
  const client = run.client_id ? await getClient(userId, tenant, run.client_id) : null;

  // C6 — run -> project. This was listed as blocked because pipeline_runs had no project_id at all; W0
  // added the column and WD-30 populates it, so the link is finally resolvable.
  //
  // The reason for NOT writing `.catch(() => null)` here: that folds a 403 and a 404 into one value, and
  // the page would then explain a refusal as "it may have been deleted" — a confident wrong answer, and
  // exactly criterion 5 of the agentic-native bar ("never an empty result that reads as no-data").
  // Distinguished so each case can say what actually happened.
  let project: Awaited<ReturnType<typeof getProject>> | null = null;
  let projectRefused = false;
  if (run.project_id) {
    try {
      project = await getProject(userId, tenant, run.project_id);
    } catch (e) {
      // 403 = the project exists and this user may not see it; anything else (404 included) = gone.
      if (e instanceof PlatformError && e.status === 403) projectRefused = true;
      else if (!(e instanceof PlatformError)) throw e;
    }
  }

  // PRV-04 — the "Site & repo" card. Same refuse-vs-empty discipline as the project link above:
  // `not_enabled`/`refused` are distinct states from "zero sites", never coalesced (see
  // lib/webdevProvisionedSites-data.ts's header for why).
  const sitesRead = await listProvisionedSitesForRun(userId, tenant, run.id);
  const siteList: SiteListState = sitesRead.ok
    ? { kind: "ok", sites: sitesRead.sites }
    : { kind: sitesRead.reason === "not_enabled" ? "not_enabled" : "refused" };

  async function onDecide(formData: FormData) {
    "use server";
    await decideGateAction(formData);
  }

  async function onEditArtifact(formData: FormData) {
    "use server";
    await editStageArtifactAction(formData);
  }

  async function onRecordScopeSignoff(formData: FormData) {
    "use server";
    await recordScopeSignoffAction(formData);
  }

  async function onUpdateStatus(formData: FormData) {
    "use server";
    await updateRunStatusAction(formData);
  }

  async function onCreateStage(formData: FormData) {
    "use server";
    await createStageAction(formData);
  }

  async function onOpenGate(formData: FormData) {
    "use server";
    await openGateAction(formData);
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
                <>No client is linked to this run, so it won&apos;t appear in any client portal. The client comes from the meeting the
                {" "}run started from — a run created directly has none.</>
              )}
            </div>
            {/* C6 — run -> project. The counterpart hop (run -> source meeting -> project) is the row
                above; this is the direct one, which only became possible once runs carried project_id. */}
            <div className="pl-link-row__item">
              {run.project_id ? (
                project ? (
                  <>Project: <Link href={`/projects/${run.project_id}`}>{project.name}</Link></>
                ) : projectRefused ? (
                  <>Project: you don&apos;t have access to it (it exists — ask an admin if you need it)</>
                ) : (
                  <>Project: not found (id {run.project_id} — it may have been deleted)</>
                )
              ) : (
                <>No project is linked to this run. It is set from the meeting the run started from, so a
                {" "}meeting recorded outside a project workspace produces a run with none.</>
              )}
            </div>
          </div>
        </Card>

        <SiteRepoCard
          runId={run.id}
          list={siteList}
          mayProvision={mayDecide}
          actions={{ provision: provisionSiteAction, reconcile: reconcileSiteAction }}
        />

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

        <Card title="Scope sign-off">
          <ScopeSignoffPanel run={run} mayDecide={mayDecide} onRecord={onRecordScopeSignoff} />
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

        {/* MAIL-15 — inbound replies to this run's approval/gate mail (design §8A). Self-contained:
            fetches its own data via the entity-scoped BFF read (A10), absence-degrades to empty. */}
        <MailThreadPanel userId={userId} tenantId={tenant} entityType="pipeline_run" entityId={run.id} />
      </div>

      {/* B3–B5 — run lifecycle recovery tools. Deliberately NOT a Card next to the routine
          approve/edit controls above: these bypass automation (park a stuck run, add a beat by
          hand, open a gate the workflow missed), so they're gated on the same elevated capability
          but rendered collapsed, in a warning-toned box, so a manager has to choose to open it
          rather than stumble into it while doing routine review. */}
      {mayDecide && (
        <details className="pl-recovery">
          <summary className="pl-recovery__summary">Recovery tools — manual overrides for when automation didn&apos;t advance this run</summary>
          <div className="pl-recovery__body">
            <div className="pl-recovery__group">
              <Eyebrow style={{ display: "block", marginBottom: 8 }}>Update run status</Eyebrow>
              <p className="pl-recovery__hint">Park a stuck run, or unblock one once the underlying issue is resolved.</p>
              <form action={onUpdateStatus} className="pl-recovery__form">
                <input type="hidden" name="runId" value={run.id} />
                <select name="status" defaultValue={run.status}>
                  {RUN_STATUSES.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                  ))}
                </select>
                <button type="submit" className="btn">Update status</button>
              </form>
            </div>

            <div className="pl-recovery__group">
              <Eyebrow style={{ display: "block", marginBottom: 8 }}>Add a stage by hand</Eyebrow>
              <p className="pl-recovery__hint">Create a beat automation didn&apos;t — use the same slug convention as the workflow (e.g. <code>manual_review</code>).</p>
              <form action={onCreateStage} className="pl-recovery__form">
                <input type="hidden" name="runId" value={run.id} />
                <select name="track" defaultValue="delivery">
                  {TRACK_ORDER.map((t) => (
                    <option key={t} value={t}>{TRACK_LABEL[t]}</option>
                  ))}
                </select>
                <input type="text" name="name" placeholder="stage name" required />
                <button type="submit" className="btn">Add stage</button>
              </form>
            </div>

            <div className="pl-recovery__group">
              <Eyebrow style={{ display: "block", marginBottom: 8 }}>Open a gate manually</Eyebrow>
              <p className="pl-recovery__hint">The only recovery when a workflow missed opening a review or sign-off beat.</p>
              <form action={onOpenGate} className="pl-recovery__form">
                <input type="hidden" name="runId" value={run.id} />
                <select name="kind" defaultValue="pm_review">
                  {ALL_GATE_KINDS.map((k) => (
                    <option key={k} value={k}>{GATE_LABEL[k]}</option>
                  ))}
                </select>
                <select name="actorSide" defaultValue="internal">
                  {ACTOR_SIDES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <input type="text" name="note" placeholder="Note (optional)" />
                <button type="submit" className="btn">Open gate</button>
              </form>
            </div>
          </div>
        </details>
      )}
    </>
  );
}

// B1 — the scope dual-sign panel: who's signed, who's outstanding, and (elevated + agency not yet
// signed) the form to record the agency's half. `summarizeScopeSignoffs` words `complete:false`
// honestly ("waiting on the client") rather than letting the run look stuck once the agency signs.
function ScopeSignoffPanel({ run, mayDecide, onRecord }: {
  run: Pick<PipelineRunDetail, "id" | "scopeSignoffs">;
  mayDecide: boolean;
  onRecord: (formData: FormData) => Promise<void>;
}) {
  const summary = summarizeScopeSignoffs(run.scopeSignoffs);
  const agencySigned = summary.signed.includes("provider");
  return (
    <div>
      <p className="pl-scope__summary">{summary.text}</p>
      <div className="pl-scope__parties">
        {SCOPE_PARTIES.map((party) => {
          const rec = run.scopeSignoffs.find((s) => s.party === party);
          return (
            <div key={party} className="pl-scope__party">
              <span className="pl-scope__party-name">{SCOPE_PARTY_LABEL[party]}</span>
              <StatusBadge label={rec ? "signed" : party === "client" ? "waiting on client" : "not yet signed"} />
              {rec && (
                <span className="pl-scope__meta">
                  {rec.signer_name ? `${rec.signer_name} · ` : ""}{formatDateTime(rec.signed_at)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {mayDecide && !agencySigned && (
        <form action={onRecord} className="pl-scope__form">
          <input type="hidden" name="runId" value={run.id} />
          <label className="pl-scope__field">
            <span>Signer name (optional)</span>
            <input type="text" name="signerName" placeholder="Who is signing for the agency?" />
          </label>
          <button type="submit" className="btn btn-primary" style={{ fontSize: 13, alignSelf: "flex-start" }}>Record agency sign-off</button>
        </form>
      )}
      {!mayDecide && !agencySigned && (
        <p className="pl-scope__meta">Recording the agency&apos;s sign-off requires manager-tier access.</p>
      )}
    </div>
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
