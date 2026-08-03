"use client";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import type { MeetingResult, AudioUploadResult } from "@/lib/meetingsActions";
import { useMediaRecorder, formatElapsed, formatBytes } from "./useMediaRecorder";

// WS11 capture edge — the in-ERP recorder: Start · Pause/Resume · Stop, then Play/Pause + seek on the
// take, then "Save & transcribe" which pushes the blob down the SAME server-side transcription path
// as an uploaded file (`POST /api/:t/meetings/recordings/:id/audio` -> whisper -> `transcribed`).
//
// It replaces nothing: the desktop capture-helper (local whisper, video, Drive sync) and the
// file-upload fallback both remain. What did not exist before is the ability to record AT ALL from
// the browser — the old "Record" buttons only registered a meeting row.
//
// TWO MODES, because the two call sites genuinely differ (the same split `AudioUploadForm` and
// `registerAndUploadAudioAction` already make):
//   * "register" — no recording row yet (/meetings, PRD studio, client + project workspaces): the
//     action registers the meeting AND uploads in one step, then redirects to the detail page.
//   * "existing" — a recording row is already on screen (/meetings/[id] workbench): upload into it.
//
// AUDIO ONLY — see the header of useMediaRecorder.ts: the backend's audio allowlist rejects every
// `video/*` container, so an in-browser video take would be refused after the whole upload. Video
// capture stays with the desktop helper.

type RegisterMode = {
  mode: "register";
  /** `registerAndUploadAudioAction` — registers then uploads, then redirects. */
  action: (prev: MeetingResult | null, formData: FormData) => Promise<MeetingResult>;
  clientId?: string;
  projectId?: string;
};
type ExistingMode = {
  mode: "existing";
  /** `uploadAudioAction` — uploads into an existing row. */
  action: (prev: AudioUploadResult | null, formData: FormData) => Promise<AudioUploadResult>;
  recordingId: string;
  /** Called once the upload action reports success, so the parent can flip to its transcribing poll. */
  onUploaded?: () => void;
};
export type LiveRecorderProps = RegisterMode | ExistingMode;

const DOT = "●";

export function LiveRecorder(props: LiveRecorderProps) {
  const r = useMediaRecorder();
  // One `useActionState` over whichever action this mode uses. Both action shapes are
  // `(prev, FormData) => Promise<{ok,error?}>`, so the union is safe to narrow to the common part.
  const [state, dispatch, pending] = useActionState<(MeetingResult & AudioUploadResult) | null, FormData>(
    props.action as (
      prev: (MeetingResult & AudioUploadResult) | null,
      formData: FormData,
    ) => Promise<(MeetingResult & AudioUploadResult) | null>,
    null,
  );
  const [title, setTitle] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // ── Playback ────────────────────────────────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  // A fresh take invalidates any previous playback state.
  useEffect(() => {
    setPlaying(false);
    setPosition(0);
    setDuration(0);
  }, [r.blobUrl]);

  useEffect(() => {
    if (props.mode === "existing" && state?.ok) props.onUploaded?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  /** MediaRecorder webm/ogg blobs commonly report `duration: Infinity` until the element has been
   *  seeked, which would make the scrubber unusable. The recorder's own paused-aware clock is an
   *  accurate substitute, so prefer it whenever the element's value is not finite. */
  const effectiveDuration = Number.isFinite(duration) && duration > 0 ? duration : r.elapsedMs / 1000;

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, []);

  const seek = useCallback((secs: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = secs;
    setPosition(secs);
  }, []);

  // ── Submit ──────────────────────────────────────────────────────────────────────────────────────
  const save = useCallback(() => {
    if (!r.blob) return;
    const fd = new FormData();
    // A File (not a bare Blob) so the multipart part carries a filename — the backend accepts a
    // generic content-type only when the EXTENSION is a known audio one.
    fd.append("file", new File([r.blob], r.fileName, { type: r.blob.type || "audio/webm" }), r.fileName);
    if (props.mode === "register") {
      if (title.trim()) fd.append("title", title.trim());
      if (props.clientId) fd.append("clientId", props.clientId);
      if (props.projectId) fd.append("projectId", props.projectId);
    } else {
      fd.append("id", props.recordingId);
    }
    setSubmitted(true);
    dispatch(fd);
  }, [dispatch, props, r.blob, r.fileName, title]);

  const busy = pending || submitted;
  const recording = r.phase === "recording";
  const paused = r.phase === "paused";
  const live = recording || paused;
  const reviewing = r.phase === "review" && !!r.blob;
  const blocked = r.phase === "denied" || r.phase === "unsupported";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* ── Transport ───────────────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {!live && !reviewing && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void r.start()}
            disabled={r.phase === "requesting" || busy}
            style={{ fontSize: 14 }}
          >
            {r.phase === "requesting" ? "Waiting for mic…" : "🎙️  Start recording"}
          </button>
        )}

        {recording && r.canPause && (
          <button type="button" className="btn" onClick={r.pause} style={{ fontSize: 14 }}>
            ⏸  Pause
          </button>
        )}
        {paused && (
          <button type="button" className="btn btn-primary" onClick={r.resume} style={{ fontSize: 14 }}>
            ⏵  Resume
          </button>
        )}
        {live && (
          <button type="button" className="btn" onClick={r.stop} style={{ fontSize: 14 }}>
            ⏹  Stop
          </button>
        )}

        {/* Live status: a recording indicator that stops blinking when paused, so "paused" is
            visible at a glance and not just implied by which buttons are showing. */}
        {live && (
          <span
            aria-live="polite"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              font: "500 13px var(--font-body)",
              color: recording ? "var(--erp-accent)" : "var(--ink-muted)",
            }}
          >
            <span aria-hidden="true" style={{ opacity: recording ? 1 : 0.4 }}>{DOT}</span>
            {recording ? "Recording" : "Paused"} · {formatElapsed(r.elapsedMs)}
            {r.sizeBytes > 0 && <span style={{ color: "var(--ink-subtle)" }}>· {formatBytes(r.sizeBytes)}</span>}
          </span>
        )}

        {/* Input-level meter — the only affordance that distinguishes "recording" from "recording
            silence because the wrong input device is selected". */}
        {live && (
          <span
            aria-hidden="true"
            title="Input level"
            style={{ display: "inline-flex", gap: 3, alignItems: "flex-end", height: 18 }}
          >
            {[0.15, 0.35, 0.55, 0.75, 0.9].map((threshold) => (
              <span
                key={threshold}
                style={{
                  width: 4,
                  height: `${6 + threshold * 12}px`,
                  borderRadius: 2,
                  background: r.level >= threshold ? "var(--erp-accent)" : "var(--line)",
                  transition: "background 120ms linear",
                }}
              />
            ))}
          </span>
        )}
      </div>

      {r.nearSizeLimit && live && (
        <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--erp-accent)" }} aria-live="polite">
          Approaching the 200 MB limit — recording will stop automatically and keep what it has.
        </p>
      )}

      {r.error && (
        <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "var(--erp-accent)", opacity: 0.9 }}>
          {r.error}
        </p>
      )}

      {/* ── Review: playback + save ──────────────────────────────────────────────────────────── */}
      {reviewing && (
        <div style={{ display: "grid", gap: 10, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10 }}>
          {/* Hidden native element drives playback; the visible controls below are ours so they
              match the rest of the console. `preload="metadata"` lets duration resolve early. */}
          <audio
            ref={audioRef}
            src={r.blobUrl ?? undefined}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => {
              setPlaying(false);
              setPosition(0);
            }}
            onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onDurationChange={(e) => setDuration(e.currentTarget.duration)}
            style={{ display: "none" }}
          />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              onClick={togglePlay}
              disabled={busy}
              aria-label={playing ? "Pause playback" : "Play recording"}
              style={{ fontSize: 14 }}
            >
              {playing ? "⏸  Pause" : "▶  Play"}
            </button>
            <span style={{ font: "400 13px var(--font-body)", color: "var(--ink-muted)", minWidth: 92 }}>
              {formatElapsed(position * 1000)} / {formatElapsed(effectiveDuration * 1000)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(effectiveDuration, 0.1)}
              step={0.1}
              value={Math.min(position, effectiveDuration)}
              onChange={(e) => seek(Number(e.target.value))}
              disabled={busy}
              aria-label="Seek within the recording"
              style={{ flex: "1 1 160px", accentColor: "var(--erp-accent)" }}
            />
          </div>

          <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
            {formatElapsed(r.elapsedMs)} · {formatBytes(r.sizeBytes)} · {r.mimeType?.split(";")[0] ?? "audio"}
          </p>

          {props.mode === "register" && (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Meeting title (optional)"
              disabled={busy}
              style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, font: "400 14px var(--font-body)" }}
            />
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy} style={{ fontSize: 14 }}>
              {busy ? "Uploading…" : "Save & transcribe"}
            </button>
            {/* Re-record is destructive, so it is disabled while an upload is in flight rather than
                silently discarding bytes that are already on their way. */}
            <button type="button" className="btn" onClick={r.reset} disabled={busy} style={{ fontSize: 14 }}>
              Discard & re-record
            </button>
            <a
              href={r.blobUrl ?? undefined}
              download={r.fileName}
              className="btn"
              style={{ fontSize: 14, textDecoration: "none", pointerEvents: busy ? "none" : undefined, opacity: busy ? 0.5 : 1 }}
            >
              ⤓  Save a local copy
            </a>
          </div>

          {state?.error && (
            <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.9 }}>
              {state.error}
              {/* The take survives a failed upload — nothing is discarded unless the user says so. */}
              <br />
              <span style={{ color: "var(--ink-subtle)" }}>Your recording is still here — try Save again, or download a local copy.</span>
            </p>
          )}
          {state?.ok && props.mode === "existing" && (
            <p style={{ margin: 0, font: "500 13px var(--font-body)", color: "var(--ink-muted)" }}>
              ✓ Uploaded — transcription is running.
            </p>
          )}
        </div>
      )}

      {/* A failed upload leaves `submitted` true; re-enable Save so a retry is possible. */}
      {submitted && state?.error && <ResetSubmitted onReset={() => setSubmitted(false)} />}

      {blocked && (
        <p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
          In-browser recording is unavailable here. Use the upload path below, or install the desktop
          capture helper for local transcription and video.
        </p>
      )}
    </div>
  );
}

/** Clears the local `submitted` latch after a failed upload, in an effect rather than during render.
 *  Separate component so the effect runs only while an error is actually on screen. */
function ResetSubmitted({ onReset }: { onReset: () => void }) {
  useEffect(() => {
    onReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
