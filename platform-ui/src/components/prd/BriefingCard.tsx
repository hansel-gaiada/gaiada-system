"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useState } from "react";
import type { MeetingRecording, RecordingStatus } from "@/lib/meetings";
import type { AudioUploadResult, MeetingResult } from "@/lib/meetingsActions";
import { briefingPhase } from "@/lib/prdFlow";
import { LiveRecorder } from "@/components/meetings/LiveRecorder";
import { formatMb, uploadRecordingFile, type UploadOutcome, type UploadProgress } from "./uploadWithProgress";
import "./prd-studio.css";

// Steps 2 and 3 for ONE briefing. The card shows one headline (where it is), one next step (what to
// do), and only the controls that next step needs — the three capture methods appear only while
// there is no recording, the convert button only once the transcript exists. Actions arrive as
// props (the page passes the real server actions) so the card is testable with stubs, the same
// pattern as ChangeRequestsPanel.
export interface BriefingCardActions {
  /** `uploadAudioAction` — the in-browser take from LiveRecorder goes through this server action. */
  upload: (prev: AudioUploadResult | null, formData: FormData) => Promise<AudioUploadResult>;
  /** "Upload a file": the browser streams the file itself (XHR, with progress) through the BFF route
   *  `api/meetings/[id]/audio`. Defaults to `uploadRecordingFile`; injectable for tests. */
  uploadFile?: (recordingId: string, file: File, onProgress: (p: UploadProgress) => void) => Promise<UploadOutcome>;
  /** `retryAudioAction` — re-run transcription on the already-uploaded audio. */
  retry: (prev: AudioUploadResult | null, formData: FormData) => Promise<AudioUploadResult>;
  /** `ingestAction` — convert the transcript into a PRD pipeline run. */
  ingest: (prev: MeetingResult | null, formData: FormData) => Promise<MeetingResult>;
}

type Method = "browser" | "helper" | "upload";
const POLL_MS = 2500;
const PROCESSING = new Set<RecordingStatus>(["recorded", "transcribing"]);

export function BriefingCard({
  recording,
  clientName,
  projectName,
  actions,
}: {
  recording: MeetingRecording;
  clientName?: string | null;
  projectName?: string | null;
  actions: BriefingCardActions;
}) {
  const router = useRouter();
  const [liveStatus, setLiveStatus] = useState<RecordingStatus>(recording.status);
  const [method, setMethod] = useState<Method | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploading = progress !== null;
  const [retryState, retryAction, retrying] = useActionState<AudioUploadResult | null, FormData>(actions.retry, null);
  const [ingestState, ingestAction, ingesting] = useActionState<MeetingResult | null, FormData>(actions.ingest, null);

  // Server data wins whenever the page re-renders with a newer row.
  useEffect(() => setLiveStatus(recording.status), [recording.status]);

  // Same poll AudioUploadForm runs: only while processing, stops itself on a terminal state and asks
  // the page to re-read so the card flips to "Transcript ready" without a manual reload.
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/meetings/${recording.id}/status`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { status: RecordingStatus };
      setLiveStatus((prev) => {
        if (body.status !== prev && !PROCESSING.has(body.status)) router.refresh();
        return body.status;
      });
    } catch {
      // transient — next tick retries
    }
  }, [recording.id, router]);

  useEffect(() => {
    if (retryState?.ok) { setLiveStatus("transcribing"); setMethod(null); }
  }, [retryState]);

  async function submitFile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || uploading) return;
    setUploadError(null);
    setProgress({ fraction: 0, loaded: 0, total: file.size });
    const outcome = await (actions.uploadFile ?? uploadRecordingFile)(recording.id, file, setProgress);
    setProgress(null);
    if (outcome.ok) {
      setFile(null);
      setMethod(null);
      setLiveStatus("transcribing");
    } else {
      setUploadError(outcome.error);
    }
  }

  useEffect(() => {
    if (!PROCESSING.has(liveStatus)) return;
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [liveStatus, poll]);

  useEffect(() => {
    if (ingestState?.ok) { setLiveStatus("ingested"); router.refresh(); }
  }, [ingestState, router]);

  const view = briefingPhase(liveStatus);
  const isVideo = recording.kind === "video";
  const cardClass = ["prd-card", view.phase === "ready" && "prd-card--ready", view.phase === "failed" && "prd-card--failed"].filter(Boolean).join(" ");

  return (
    <article className={cardClass} aria-label={recording.title ?? "Untitled briefing"}>
      <div className="prd-card__head">
        <div>
          <h3 className="prd-card__title">{recording.title ?? "Untitled briefing"}</h3>
          <div className="prd-card__meta">
            <span>{clientName ?? (recording.client_id ? recording.client_id : "No client")}</span>
            {projectName && <span>· {projectName}</span>}
            <span>· {isVideo ? "Audio + video" : "Audio"}</span>
          </div>
        </div>
        <Link href={`/meetings/${recording.id}`} className="prd-card__open">Open briefing →</Link>
      </div>

      <div className="prd-state">
        <span className="prd-state__headline">
          {view.phase === "processing" && <span className="prd-pulse" aria-hidden="true" />}
          {view.headline}
        </span>
        {view.next && <span className="prd-state__next">{view.next}</span>}
      </div>

      {view.phase === "capture" && (
        <div className="prd-methods" role="group" aria-label="How to add the recording">
          <button type="button" className="prd-method" aria-pressed={method === "browser"} onClick={() => setMethod(method === "browser" ? null : "browser")}>Record here</button>
          <button type="button" className="prd-method" aria-pressed={method === "helper"} onClick={() => setMethod(method === "helper" ? null : "helper")}>Desktop capture helper</button>
          <button type="button" className="prd-method" aria-pressed={method === "upload"} onClick={() => setMethod(method === "upload" ? null : "upload")}>Upload a file</button>
        </div>
      )}

      {view.phase === "capture" && method === "browser" && (
        <div className="prd-panel">
          <p className="prd-hint">Records in this browser and transcribes on the server. Nothing leaves your machine until you press save.</p>
          <LiveRecorder mode="existing" recordingId={recording.id} video={isVideo} action={actions.upload} onUploaded={() => setLiveStatus("transcribing")} />
        </div>
      )}

      {view.phase === "capture" && method === "helper" && (
        <div className="prd-panel">
          <p className="prd-hint">
            In the desktop capture helper, start a recording for this meeting id. It records and transcribes on your machine, then attaches the transcript here on its own.
          </p>
          <div className="prd-kv">
            <span className="prd-kv__label">Meeting id</span>
            <code className="prd-mono">{recording.meeting_id}</code>
          </div>
        </div>
      )}

      {(view.phase === "capture" || view.phase === "failed") && method === "upload" && (
        <form onSubmit={submitFile} className="prd-panel">
          <label className="prd-field">
            Audio or video file
            <input
              type="file"
              name="file"
              disabled={uploading}
              accept="audio/*,video/*,.m4a,.mp3,.mp4,.wav,.webm,.ogg,.flac,.aac,.mov,.mkv,.3gp,.m4v"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUploadError(null); }}
            />
          </label>
          {progress ? (
            <div className="prd-progress" role="status" aria-live="polite">
              <progress className="prd-progress__bar" value={progress.loaded} max={progress.total || 1} />
              <span className="prd-progress__text">
                {Math.round(progress.fraction * 100)}% · {formatMb(progress.loaded)} of {formatMb(progress.total)}
              </span>
            </div>
          ) : (
            <div className="prd-actions">
              <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!file}>Upload & transcribe</button>
              {file && <span className="prd-hint">{file.name} · {formatMb(file.size)}</span>}
              {uploadError && <p className="prd-note prd-note--error">{uploadError}</p>}
            </div>
          )}
        </form>
      )}

      {view.phase === "failed" && (
        <div className="prd-actions">
          <form action={retryAction}>
            <input type="hidden" name="id" value={recording.id} />
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={retrying}>{retrying ? "Retrying…" : "Retry transcription"}</button>
          </form>
          <button type="button" className="prd-method" aria-pressed={method === "upload"} onClick={() => setMethod(method === "upload" ? null : "upload")}>Upload a different file</button>
          {retryState && !retryState.ok && retryState.error && <p className="prd-note prd-note--error">{retryState.error}</p>}
        </div>
      )}

      {view.phase === "ready" && (
        <form action={ingestAction} className="prd-actions">
          <input type="hidden" name="id" value={recording.id} />
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--md" disabled={ingesting}>{ingesting ? "Converting…" : "Convert to PRD run"}</button>
          <Link href={`/meetings/${recording.id}`} className="prd-card__open">Read the transcript first</Link>
          {ingestState && !ingestState.ok && ingestState.error && <p className="prd-note prd-note--error">{ingestState.error}</p>}
        </form>
      )}

      {view.phase === "in_pipeline" && (
        <p className="prd-note prd-note--ok">Converted. Its approvals now show under PRD runs below.</p>
      )}
    </article>
  );
}
