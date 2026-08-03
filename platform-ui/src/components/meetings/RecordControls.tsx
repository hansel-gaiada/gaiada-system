"use client";
import { useActionState, useState } from "react";
import { startRecordingAction, registerAndUploadAudioAction, type MeetingResult } from "@/lib/meetingsActions";
import { LiveRecorder } from "./LiveRecorder";
import "@/components/departments/departments.css";

// WS11 capture edge — the two "kick off a recording" buttons in the ERP. The desktop capture-helper
// performs the actual OS-level capture + local transcription; this registers the meeting (minting a
// stable meetingId) so it appears in the registry and the helper can attach to it. Without the helper,
// this still lets you register an externally-made recording, then paste its transcript on the detail page.
//
// WD-07 (Web Dev Phase 1 §12) — two additions: (1) optional `clientId`/`projectId` props so a
// recording started from a client/project workspace lands scoped to it (plumbed straight into
// `startRecordingAction`'s hidden fields — the backend already accepts both on `/start`); (2) a
// "no capture helper?" upload path (WD-04's server-side transcription, surfaced here for the
// no-existing-recording case — `RecordingWorkbench`/`AudioUploadForm` covers the existing-recording
// case on the detail page).
export function RecordControls({ clientId, projectId }: { clientId?: string; projectId?: string } = {}) {
  const [state, formAction, pending] = useActionState<MeetingResult | null, FormData>(startRecordingAction, null);
  const [uploadState, uploadFormAction, uploadPending] = useActionState<MeetingResult | null, FormData>(registerAndUploadAudioAction, null);
  const [fileName, setFileName] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [withVideo, setWithVideo] = useState(false);

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {/* Record HERE, in the browser — start / pause / resume / stop, play the take back, then send
          it down the server-side transcription path. This is the primary affordance now: the two
          buttons below it only REGISTER a meeting for the desktop helper to attach to, which is a
          different (and much less obvious) thing. */}
      <div style={{ display: "grid", gap: 10 }}>
        <h3 style={{ margin: 0, font: "600 14px var(--font-body)", color: "var(--ink)" }}>Record now</h3>

        {/* Audio vs video is chosen BEFORE starting, because it decides which devices are requested
            (and therefore which permission prompt appears) — it cannot be switched mid-take. Radio
            semantics via a group, so the choice is announced rather than implied by styling. */}
        <div role="radiogroup" aria-label="What to record" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {([
            ["audio", "🎙️  Audio"],
            ["video", "🎥  Audio + Video"],
          ] as const).map(([value, label]) => {
            const selected = (value === "video") === withVideo;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setWithVideo(value === "video")}
                className={selected ? "btn btn-primary" : "btn"}
                style={{ fontSize: 13 }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Keyed on the mode so switching audio<->video mounts a FRESH recorder: the alternative is
            carrying a finished audio take into a video session, where "Save & transcribe" would
            silently upload the wrong medium. */}
        <LiveRecorder
          key={withVideo ? "video" : "audio"}
          mode="register"
          video={withVideo}
          action={registerAndUploadAudioAction}
          clientId={clientId}
          projectId={projectId}
        />
      </div>

      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: 0 }} />

      <form action={formAction} style={{ display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0, font: "600 14px var(--font-body)", color: "var(--ink)" }}>
          Or register a meeting for the desktop capture helper
        </h3>
        {clientId && <input type="hidden" name="clientId" value={clientId} />}
        {projectId && <input type="hidden" name="projectId" value={projectId} />}
        <input
          name="title"
          placeholder="Meeting title (e.g. Northwind — kickoff)"
          style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 14px var(--font-body)" }}
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
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
            Recording registered. The capture helper will attach the local file; then add its transcript below.
          </p>
        )}
        {state?.error && (
          <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.85 }}>{state.error}</p>
        )}
        <p style={{ margin: "2px 0 0", font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
          For the desktop capture helper only: it saves the recording on your machine and transcribes
          it locally, then attaches it here. Use &ldquo;Record now&rdquo; above if you don&rsquo;t have
          the helper installed &mdash; that records in this browser and transcribes on the server.
        </p>
      </form>

      {/* WD-07 helper-offline teach state: no capture helper installed? Skip the local-whisper
          path entirely and upload the audio file straight into server-side transcription. */}
      <div className="dept-teach" style={{ padding: "12px 14px" }}>
        <span className="dept-teach__glyph" aria-hidden="true">☁️</span>
        <span className="dept-teach__title">No capture helper installed?</span>
        <span className="dept-teach__body">
          Upload an audio or video file recorded elsewhere (phone, Zoom, etc.) — it&rsquo;s transcribed
          on the server, no local whisper needed. Video is transcribed from its audio track and kept as
          the media artifact.
        </span>
        {!showUpload && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm dept-teach__cta" onClick={() => setShowUpload(true)}>
            Upload a file
          </button>
        )}
      </div>

      {showUpload && (
        <form action={uploadFormAction} style={{ display: "grid", gap: 10 }}>
          {clientId && <input type="hidden" name="clientId" value={clientId} />}
          {projectId && <input type="hidden" name="projectId" value={projectId} />}
          <input
            name="title"
            placeholder="Meeting title (optional)"
            style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 14px var(--font-body)" }}
          />
          <input
            type="file"
            name="file"
            accept="audio/*,video/*,.m4a,.mp3,.mp4,.wav,.webm,.ogg,.flac,.aac,.mov,.mkv,.3gp,.m4v"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
            style={{ font: "400 13px var(--font-body)" }}
            required
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="submit" className="btn" disabled={uploadPending || !fileName} style={{ fontSize: 14 }}>
              {uploadPending ? "Uploading…" : "Upload & transcribe"}
            </button>
            {uploadState?.error && (
              <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.85 }}>{uploadState.error}</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
