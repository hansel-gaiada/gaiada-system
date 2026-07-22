"use client";
import { useActionState } from "react";
import { startRecordingAction, type MeetingResult } from "@/lib/meetingsActions";

// WS11 capture edge — the two "kick off a recording" buttons in the ERP. The desktop capture-helper
// performs the actual OS-level capture + local transcription; this registers the meeting (minting a
// stable meetingId) so it appears in the registry and the helper can attach to it. Without the helper,
// this still lets you register an externally-made recording, then paste its transcript on the detail page.
export function RecordControls() {
  const [state, formAction, pending] = useActionState<MeetingResult | null, FormData>(startRecordingAction, null);

  return (
    <form action={formAction} style={{ display: "grid", gap: 12 }}>
      <input
        name="title"
        placeholder="Meeting title (e.g. Northwind — kickoff)"
        style={{ padding: "10px 12px", border: "1px solid rgba(26,25,22,.14)", borderRadius: 10, font: "400 14px var(--font-body)" }}
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="submit" name="kind" value="audio" className="btn btn-primary" disabled={pending} style={{ fontSize: 14 }}>
          {pending ? "Starting…" : "🎙️  Record Audio"}
        </button>
        <button type="submit" name="kind" value="video" className="btn" disabled={pending} style={{ fontSize: 14 }}>
          {pending ? "Starting…" : "🎥  Record Audio + Video"}
        </button>
      </div>
      {state?.ok && (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "rgba(26,25,22,.6)" }}>
          Recording registered. The capture helper will attach the local file; then add its transcript below.
        </p>
      )}
      {state?.error && (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.85 }}>{state.error}</p>
      )}
      <p style={{ margin: "2px 0 0", font: "400 12px/1.5 var(--font-body)", color: "rgba(26,25,22,.45)" }}>
        Local-first: the recording is saved on your machine and transcribed locally — only the transcript
        text is sent to the pipeline. You&rsquo;ll be reminded to sync the media to the company Drive.
      </p>
    </form>
  );
}
