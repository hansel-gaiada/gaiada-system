"use client";
import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AudioUploadResult } from "@/lib/meetingsActions";
import type { RecordingStatus } from "@/lib/meetings";

// WD-04/WD-07 (Web Dev Phase 1 §12, Part A) — the in-ERP audio-upload fallback: no capture-helper
// installed? Upload the recording file directly and it gets transcribed server-side (whisper
// container, called directly — not via ai-gateway-go, meeting-length audio exceeds its ~2.5-min
// per-call timeout). Upload responds 202 `{status:"transcribing"}` immediately (fire-and-forget
// job); this component then polls `/api/meetings/:id/status` — same poll-until-terminal pattern
// as `WhatsAppConnect.tsx` (systems/) — to surface "Transcribing…" and flip to "Transcribed" or
// "Failed" + a retry button without a manual page refresh.
const POLL_INTERVAL_MS = 2500;
const TERMINAL: Set<RecordingStatus> = new Set(["transcribed", "failed", "ingested"]);

type UploadAction = (prev: AudioUploadResult | null, formData: FormData) => Promise<AudioUploadResult>;
type RetryAction = (prev: AudioUploadResult | null, formData: FormData) => Promise<AudioUploadResult>;

export function AudioUploadForm({
  recordingId,
  initialStatus,
  hasAudioRef,
  uploadAction,
  retryAction,
}: {
  recordingId: string;
  initialStatus: RecordingStatus;
  hasAudioRef: boolean;
  uploadAction: UploadAction;
  retryAction: RetryAction;
}) {
  const router = useRouter();
  const [liveStatus, setLiveStatus] = useState<RecordingStatus>(initialStatus);
  const [uploadState, uploadFormAction, uploadPending] = useActionState<AudioUploadResult | null, FormData>(uploadAction, null);
  const [retryState, retryFormAction, retryPending] = useActionState<AudioUploadResult | null, FormData>(retryAction, null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>("");

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/meetings/${recordingId}/status`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { status: RecordingStatus };
      setLiveStatus((prev) => {
        if (body.status !== prev && TERMINAL.has(body.status)) router.refresh(); // pick up the new transcript text
        return body.status;
      });
    } catch {
      // transient — next tick retries.
    }
  }, [recordingId, router]);

  // Re-poll immediately once an upload/retry action reports success (so "transcribing" shows
  // right away rather than waiting up to POLL_INTERVAL_MS).
  useEffect(() => {
    if (uploadState?.ok || retryState?.ok) {
      setLiveStatus("transcribing");
      poll();
    }
  }, [uploadState, retryState, poll]);

  // The interval itself — armed only while non-terminal, self-terminates on transcribed/failed.
  useEffect(() => {
    if (TERMINAL.has(liveStatus)) return;
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [liveStatus, poll]);

  const isTranscribing = liveStatus === "transcribing";
  const isFailed = liveStatus === "failed";
  const isTranscribed = liveStatus === "transcribed" || liveStatus === "ingested";

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)", color: "rgba(26,25,22,.6)" }}>
        No capture helper installed? Upload the recording file directly — it&rsquo;s transcribed on the
        server (no local whisper required).
      </p>

      {isTranscribing && (
        <p style={{ margin: 0, font: "500 13px var(--font-body)", color: "var(--erp-accent)" }} aria-live="polite">
          ⏳ Transcribing… this can take a while for a long recording.
        </p>
      )}
      {isTranscribed && (
        <p style={{ margin: 0, font: "500 13px var(--font-body)", color: "rgba(26,25,22,.7)" }}>
          ✓ Transcribed — see the transcript above.
        </p>
      )}
      {isFailed && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
            ✕ Transcription failed{hasAudioRef || uploadState?.audioRef ? " — you can retry without re-uploading." : "."}
          </span>
          {(hasAudioRef || !!uploadState?.audioRef) && (
            <form action={retryFormAction}>
              <input type="hidden" name="id" value={recordingId} />
              <button type="submit" className="btn" disabled={retryPending} style={{ fontSize: 13 }}>
                {retryPending ? "Retrying…" : "Retry transcription"}
              </button>
            </form>
          )}
        </div>
      )}
      {retryState?.error && (
        <p style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.85 }}>{retryState.error}</p>
      )}

      {!isTranscribing && (
        <form
          action={uploadFormAction}
          style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
          onSubmit={() => setLiveStatus("transcribing")}
        >
          <input type="hidden" name="id" value={recordingId} />
          <input
            ref={fileInputRef}
            type="file"
            name="file"
            accept="audio/*,.m4a,.mp3,.mp4,.wav,.webm,.ogg,.flac,.aac"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
            style={{ font: "400 13px var(--font-body)" }}
            required
          />
          <button type="submit" className="btn btn-primary" disabled={uploadPending || !fileName} style={{ fontSize: 13 }}>
            {uploadPending ? "Uploading…" : isFailed ? "Upload a different file" : "Upload audio"}
          </button>
          {uploadState?.error && (
            <span style={{ font: "400 13px var(--font-body)", color: "var(--erp-accent)", opacity: 0.85 }}>{uploadState.error}</span>
          )}
        </form>
      )}
    </div>
  );
}
