import Link from "next/link";
import type { MeetingRecording } from "@/lib/meetings";
import type { AudioUploadResult, MeetingResult } from "@/lib/meetingsActions";
import type { BriefingResult } from "@/lib/prdActions";
import type { PipelineGate, PipelineRun } from "@/lib/pipeline";
import { orderBriefings } from "@/lib/prdFlow";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BriefingComposer } from "./BriefingComposer";
import { BriefingCard } from "./BriefingCard";
import { RunApprovalRow } from "./RunApprovalRow";
import "./prd-studio.css";

// A project's Meetings tab IS the PRD Studio flow, filed under this project: create a briefing (client
// and project already known), add the recording, convert, approve — the same components, so the two
// surfaces cannot drift apart. Server-safe (no hooks): the workspace passes the server actions in.
export interface ProjectBriefingsActions {
  createBriefing: (prev: BriefingResult | null, formData: FormData) => Promise<BriefingResult>;
  upload: (prev: AudioUploadResult | null, formData: FormData) => Promise<AudioUploadResult>;
  retry: (prev: AudioUploadResult | null, formData: FormData) => Promise<AudioUploadResult>;
  setTranscript: (prev: MeetingResult | null, formData: FormData) => Promise<MeetingResult>;
  ingest: (prev: MeetingResult | null, formData: FormData) => Promise<MeetingResult>;
  startRunManually: (prev: BriefingResult | null, formData: FormData) => Promise<BriefingResult>;
  decideGate: (formData: FormData) => Promise<void>;
}

export function ProjectBriefings({
  project,
  recordings,
  runs,
  mayDecide,
  actions,
  prdHref,
  now = Date.now(),
}: {
  project: { id: string; name: string; clientId: string | null; clientName: string | null };
  recordings: MeetingRecording[];
  /** This project's runs with their gates (`null` = gates not read). */
  runs: Array<{ run: PipelineRun; gates: PipelineGate[] | null }>;
  mayDecide: boolean;
  actions: ProjectBriefingsActions;
  /** The department's PRD Studio, for the wider picture. */
  prdHref: string;
  now?: number;
}) {
  const briefings = orderBriefings(recordings, now);
  const recordingByMeeting = new Map(recordings.map((r) => [r.meeting_id, r]));

  return (
    <div className="prd-project">
      <section className="prd-project__section">
        <h3 className="prd-project__h">New briefing</h3>
        <BriefingComposer
          clients={[]}
          projects={[]}
          action={actions.createBriefing}
          fixed={{ clientId: project.clientId, clientName: project.clientName, projectId: project.id, projectName: project.name }}
        />
      </section>

      <section className="prd-project__section">
        <div className="prd-project__head">
          <h3 className="prd-project__h">Briefings{briefings.length > 0 ? ` (${briefings.length})` : ""}</h3>
          <Link href={prdHref} className="prd-card__open">Open PRD Studio →</Link>
        </div>
        {briefings.length === 0 ? (
          <EmptyNote>No briefings for this project yet — create one above, then add its recording.</EmptyNote>
        ) : (
          <div className="prd-briefings">
            {briefings.map((r) => (
              <BriefingCard
                key={r.id}
                recording={r}
                clientName={project.clientName}
                projectName={project.name}
                actions={{ upload: actions.upload, retry: actions.retry, setTranscript: actions.setTranscript, ingest: actions.ingest, startRunManually: actions.startRunManually }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="prd-project__section">
        <h3 className="prd-project__h">PRD runs{runs.length > 0 ? ` (${runs.length})` : ""}</h3>
        {runs.length === 0 ? (
          <EmptyNote>No PRD runs for this project yet — convert a transcribed briefing and its approvals appear here.</EmptyNote>
        ) : (
          <div className="prd-runs">
            {runs.map(({ run, gates }) => {
              const rec = run.source_meeting_id ? recordingByMeeting.get(run.source_meeting_id) : undefined;
              return (
                <RunApprovalRow
                  key={run.id}
                  run={run}
                  gates={gates}
                  briefingHref={rec ? `/meetings/${rec.id}` : null}
                  briefingTitle={rec?.title ?? null}
                  mayDecide={mayDecide}
                  onDecide={actions.decideGate}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
