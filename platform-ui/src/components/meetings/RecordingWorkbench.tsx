"use client";
import { useActionState } from "react";
import Link from "next/link";
import { setTranscriptAction, ingestAction, markDriveAction, uploadAudioAction, retryAudioAction, type MeetingResult } from "@/lib/meetingsActions";
import type { MeetingRecordingDetail } from "@/lib/meetings";
import { AudioUploadForm } from "./AudioUploadForm";

// WS11 capture edge — the per-recording workbench on the detail page: add/replace the transcript,
// ingest it into the delivery pipeline (proxied server-side), and record the Drive-sync nudge/result.
const noteStyle = { margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" } as const;
const errStyle = { margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.85 } as const;

function TranscriptForm({ rec }: { rec: MeetingRecordingDetail }) {
  const [state, action, pending] = useActionState<MeetingResult | null, FormData>(setTranscriptAction, null);
  return (
    <form action={action} style={{ display: "grid", gap: 10 }}>
      <input type="hidden" name="id" value={rec.id} />
      <textarea
        name="text"
        defaultValue={rec.transcript ?? ""}
        rows={rec.transcript ? 10 : 6}
        placeholder="Paste the meeting transcript (.txt) here, or let the capture helper fill it from local whisper…"
        style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 13px/1.55 var(--font-body)", resize: "vertical" }}
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="submit" className="btn btn-primary" disabled={pending} style={{ fontSize: 13 }}>
          {pending ? "Saving…" : rec.transcript ? "Update transcript" : "Save transcript"}
        </button>
        {state?.ok && <span style={noteStyle}>Saved.</span>}
        {state?.error && <span style={errStyle}>{state.error}</span>}
      </div>
    </form>
  );
}

function IngestForm({ rec }: { rec: MeetingRecordingDetail }) {
  const [state, action, pending] = useActionState<MeetingResult | null, FormData>(ingestAction, null);
  const canIngest = !!rec.transcript && rec.status !== "ingested";
  return (
    <form action={action} style={{ display: "grid", gap: 10 }}>
      <input type="hidden" name="id" value={rec.id} />
      {rec.pipeline_run_id ? (
        <p style={noteStyle}>
          In the delivery pipeline as run <code>{rec.pipeline_run_id.slice(0, 8)}</code>.{" "}
          <Link href="/pipeline" style={{ color: "var(--erp-accent)" }}>Open Delivery Pipeline →</Link>
        </p>
      ) : (
        <p style={noteStyle}>
          Ingest starts the delivery pipeline: MOM → PRD / Report / Scope extraction → PRD &amp; scope sign-off.
          Only the transcript text is sent.
        </p>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="submit" className="btn btn-primary" disabled={pending || !canIngest} style={{ fontSize: 13 }}>
          {pending ? "Dispatching…" : rec.pipeline_run_id ? "Re-ingest" : "Ingest → start pipeline"}
        </button>
        {!rec.transcript && <span style={noteStyle}>Add a transcript first.</span>}
        {state?.ok && <span style={noteStyle}>Dispatched{state.runId ? ` — run ${state.runId.slice(0, 8)}` : ""}.</span>}
        {state?.error && <span style={errStyle}>{state.error}</span>}
      </div>
    </form>
  );
}

function DriveForm({ rec }: { rec: MeetingRecordingDetail }) {
  const [state, action, pending] = useActionState<MeetingResult | null, FormData>(markDriveAction, null);
  return (
    <form action={action} style={{ display: "grid", gap: 10 }}>
      <input type="hidden" name="id" value={rec.id} />
      <p style={noteStyle}>
        Media stays local first (no pipeline clog). Sync to the company Shared Drive so the team can access it.
        {rec.drive_link && (
          <> {" "}<a href={rec.drive_link} target="_blank" rel="noreferrer" style={{ color: "var(--erp-accent)" }}>Open on Drive →</a></>
        )}
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="submit" name="driveStatus" value="pending" className="btn" disabled={pending} style={{ fontSize: 13 }}>
          Remind me to upload
        </button>
        <button type="submit" name="driveStatus" value="synced" className="btn" disabled={pending} style={{ fontSize: 13 }}>
          Mark synced to Drive
        </button>
        {state?.ok && <span style={noteStyle}>Updated.</span>}
        {state?.error && <span style={errStyle}>{state.error}</span>}
      </div>
    </form>
  );
}

export function RecordingWorkbench({ rec }: { rec: MeetingRecordingDetail }) {
  return (
    <div style={{ display: "grid", gap: 22 }}>
      {/* WD-04/WD-07 (Part A) — the in-ERP upload fallback, no capture-helper required. Always
          available (someone can switch to it even after registering via the helper path), but it
          is the ONLY way to get a transcript for a recording nobody's helper ever attached to. */}
      <section>
        <h3 style={{ margin: "0 0 10px", font: "600 14px var(--font-display)" }}>Server-side transcription</h3>
        <AudioUploadForm
          recordingId={rec.id}
          initialStatus={rec.status}
          hasAudioRef={!!rec.audio_ref}
          uploadAction={uploadAudioAction}
          retryAction={retryAudioAction}
        />
      </section>
      <section>
        <h3 style={{ margin: "0 0 10px", font: "600 14px var(--font-display)" }}>Transcript</h3>
        <TranscriptForm rec={rec} />
      </section>
      <section>
        <h3 style={{ margin: "0 0 10px", font: "600 14px var(--font-display)" }}>Delivery pipeline</h3>
        <IngestForm rec={rec} />
      </section>
      <section>
        <h3 style={{ margin: "0 0 10px", font: "600 14px var(--font-display)" }}>Google Drive</h3>
        <DriveForm rec={rec} />
      </section>
    </div>
  );
}
