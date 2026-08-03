"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// WS11 capture edge — REAL in-browser audio capture with start / pause / resume / stop, plus the
// finished blob for playback and upload. Before this hook, the ERP's "Record" buttons only
// REGISTERED a meeting row and waited for the desktop capture-helper to attach a file: there was no
// way to actually record from the browser, and therefore nothing to pause, stop or play back.
//
// AUDIO **AND VIDEO**. Video was initially left out because the backend's upload validator accepted
// no `video/*` container, so a browser video take would have been refused after the whole upload had
// been sent. That has been closed at the source: `classifyMedia` now accepts video containers, and
// the local faster-whisper container was VERIFIED to demux them (an opus-only webm and a vp8+opus
// webm built from the same audio returned the identical transcript — see the note in
// platform-nest/src/core/meetings.controller.ts). So one recorder serves both kinds, and the video
// take is both the stored media artifact AND the transcription source — no separate audio pass.
//
// WHY A HOOK AND NOT COMPONENT STATE: three of the four hard parts here are lifecycle, not UI —
// releasing the microphone, keeping an accurate paused-aware clock, and tearing down the analyser
// graph. Those must happen on unmount and on every terminal path, so they live with the state that
// owns them.

/** Container preference order. The first supported one wins; every entry's bare type (before `;`)
 *  is in the backend's audio allowlist, which is what makes the resulting upload acceptable —
 *  `isAllowedAudio` splits on `;` so the `codecs=` suffix is irrelevant to it. */
const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4", // Safari
];

/** Video container preference. VP9 first for size at a given quality, VP8 as the broad fallback,
 *  `video/mp4` (h264+aac) for Safari — all three verified to transcribe. Every bare type here is in
 *  the backend's video allowlist. */
const VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4", // Safari
];

/** Bitrate ceilings for video takes. NOT cosmetic: the upload path buffers the whole file in memory
 *  server-side, so the byte cap is a real constraint rather than a formality. At ~800 kbps video +
 *  32 kbps audio a 60-minute meeting lands near 220 MB — comfortably inside the 500 MB video cap,
 *  where letting the browser pick its own (often multi-Mbps) default would blow through it in
 *  20 minutes and force-stop a meeting mid-sentence. 720p talking-head footage is fine at this rate.
 */
const VIDEO_BITS_PER_SECOND = 800_000;
const AUDIO_BITS_PER_SECOND = 32_000;

/** Extension per container, so the filename agrees with the bytes. This matters beyond tidiness:
 *  the backend accepts a GENERIC content-type (`application/octet-stream`) only when the EXTENSION
 *  is a known audio one, so a wrong extension can turn a valid upload into a 400. */
const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

/** Mirrors `MEETING_AUDIO_MAX_BYTES` (platform-nest config default 200 MB). Enforced client-side so a
 *  long recording fails EARLY and keeps its audio, instead of being discovered at the end of a
 *  200 MB upload that the server then rejects. */
export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;
/** Mirrors `MEETING_VIDEO_MAX_BYTES` (platform-nest default 500 MB) — video gets its own, larger cap
 *  on the server, so enforcing the audio number for a video take would refuse uploads the backend
 *  would have accepted. */
export const MAX_VIDEO_RECORDING_BYTES = 500 * 1024 * 1024;
const WARN_AT_FRACTION = 0.9;

/** How often the clock/level tick. 200ms is under the ~250ms at which a timer reads as laggy, while
 *  staying far cheaper than the animation-frame loop a smooth meter would need. */
const TICK_MS = 200;
/** Chunk cadence. A timeslice is REQUIRED, not cosmetic: without it `ondataavailable` fires once at
 *  stop, so the running byte total — and therefore the size guard — would not exist until too late. */
const TIMESLICE_MS = 1000;

export type RecorderPhase =
  /** No recorder yet — the initial state, and where `reset()` returns to. */
  | "idle"
  /** Waiting on the getUserMedia permission prompt. */
  | "requesting"
  | "recording"
  | "paused"
  /** Stopped with audio in hand: playback + upload are available, nothing is being captured. */
  | "review"
  /** The user (or policy) refused microphone access. Terminal until `reset()`. */
  | "denied"
  /** This browser cannot record at all — no `mediaDevices`, no `MediaRecorder`, or no supported
   *  container. Callers must fall back to file upload. */
  | "unsupported";

export interface UseMediaRecorderOptions {
  /** Capture the camera as well as the microphone. The resulting video is BOTH the stored media
   *  artifact and the transcription source (the server's whisper demuxes it). */
  video?: boolean;
}

export interface MediaRecorderApi {
  phase: RecorderPhase;
  /** What this take is. Fixed by the `video` option, not negotiated. */
  kind: "audio" | "video";
  /** The live capture stream, for a `<video>` preview while recording. Null unless a video take is
   *  in progress — an audio take has nothing to preview. */
  previewStream: MediaStream | null;
  /** The byte cap that applies to THIS take (audio and video caps differ). */
  maxBytes: number;
  /** Capture time in ms, EXCLUDING paused stretches. */
  elapsedMs: number;
  /** Normalised 0..1 input level, for a liveness meter. 0 whenever not actively recording. */
  level: number;
  blob: Blob | null;
  /** Object URL for `blob`, revoked automatically. Null until there is a blob. */
  blobUrl: string | null;
  mimeType: string | null;
  /** Bytes captured so far (live during recording, final in review). */
  sizeBytes: number;
  /** Human-facing failure text, or null. Set alongside `denied`, and on a recorder error or the
   *  size cap being hit (in which case the audio recorded SO FAR is kept). */
  error: string | null;
  /** True once the recording is within `WARN_AT_FRACTION` of the byte cap. */
  nearSizeLimit: boolean;
  /** False when this browser's MediaRecorder has no usable pause() — the Pause control must then be
   *  hidden rather than rendered dead. */
  canPause: boolean;
  /** Suggested filename, extension matching the container. */
  fileName: string;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Discard the take, release everything, return to `idle`. */
  reset: () => void;
}

function pickMimeType(video: boolean): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of video ? VIDEO_MIME_CANDIDATES : AUDIO_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // isTypeSupported can throw on malformed input in some engines — treat as unsupported.
    }
  }
  return null;
}

export function useMediaRecorder(options: UseMediaRecorderOptions = {}): MediaRecorderApi {
  const wantVideo = options.video === true;
  const maxBytes = wantVideo ? MAX_VIDEO_RECORDING_BYTES : MAX_RECORDING_BYTES;
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canPause, setCanPause] = useState(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  // Paused-aware clock. `accumulatedRef` holds completed segments; `segmentStartRef` is the current
  // segment's start (null while paused). Computing elapsed from a single start timestamp would count
  // paused time, which is exactly the bug a pause button invites.
  const accumulatedRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Set when the size cap trips, so the `onstop` handler knows this was a forced stop and must not
  // clear the error message it is stopping because of.
  const forcedStopRef = useRef(false);

  /** Release the microphone and tear down the analyser graph. Called from every terminal path AND
   *  from unmount. Releasing the tracks is what turns the browser's recording indicator off — skip
   *  it and the app looks like it is still listening after the user pressed Stop. */
  const teardownCapture = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
    const stream = streamRef.current;
    streamRef.current = null;
    // Clear the preview BEFORE stopping tracks, so a `<video srcObject>` is never pointed at a dead
    // stream (which renders as a frozen last frame that reads like the camera is still on).
    setPreviewStream(null);
    stream?.getTracks().forEach((t) => t.stop());
    setLevel(0);
  }, []);

  // Unmount safety net: navigating away mid-recording must not leave the mic open.
  useEffect(() => teardownCapture, [teardownCapture]);

  // Blob URLs are a leak if not revoked. Tied to the blob's own lifetime rather than to a phase, so
  // a discard-then-record cycle cannot orphan one.
  useEffect(() => {
    if (!blob) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const sampleLevel = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    // RMS around the 128 zero-point, scaled so ordinary speech lands mid-meter rather than
    // pinned at the bottom. Presentation only — nothing branches on this value.
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3));
  }, []);

  const startTick = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      const seg = segmentStartRef.current;
      setElapsedMs(accumulatedRef.current + (seg === null ? 0 : Date.now() - seg));
      if (seg !== null) sampleLevel();
      else setLevel(0);
    }, TICK_MS);
  }, [sampleLevel]);

  const finalise = useCallback(
    (type: string) => {
      const parts = chunksRef.current;
      chunksRef.current = [];
      // `type` must be the RECORDER's own mimeType, not our requested candidate — engines may
      // negotiate something else, and a Blob mislabelled here would upload with a content-type that
      // does not match its bytes.
      //
      // The mimeType STATE is re-synced from the same value in the same breath, because `fileName`'s
      // extension is derived from it. A test caught these two diverging: the blob said
      // `audio/ogg` while the filename still said `.webm` from the candidate requested at start().
      // That is not cosmetic — the backend accepts a generic content-type ONLY when the extension is
      // a known audio one (meetings.controller.ts `isAllowedAudio`), so a stale extension can turn a
      // perfectly good recording into a 400. One source for both, always.
      setMimeType(type);
      setBlob(parts.length ? new Blob(parts, { type }) : null);
    },
    [],
  );

  const start = useCallback(async () => {
    setError(null);
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setPhase("unsupported");
      return;
    }
    const mime = pickMimeType(wantVideo);
    if (!mime) {
      setPhase("unsupported");
      setError(
        wantVideo
          ? "This browser has no video container we can record to. Try an audio-only recording, or upload a file."
          : "This browser has no audio container we can record to. Upload a file instead.",
      );
      return;
    }

    setPhase("requesting");
    let stream: MediaStream;
    try {
      // Browser-side cleanup is worth asking for: meeting audio is speech, and echo/noise handling
      // materially improves what whisper receives.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        // 720p is `ideal`, never `exact`: an `exact` constraint makes getUserMedia throw
        // OverconstrainedError on a webcam that cannot hit it, which would turn "your camera is a bit
        // old" into "recording is broken".
        ...(wantVideo ? { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } } } : {}),
      });
    } catch (e) {
      // NotAllowedError (denied/dismissed) is the common case; NotFoundError means no input device.
      const name = (e as { name?: string })?.name ?? "";
      const devices = wantVideo ? "camera or microphone" : "microphone";
      setPhase("denied");
      setError(
        name === "NotFoundError" || name === "OverconstrainedError"
          ? `No ${devices} was found. Connect one, or upload a file instead.`
          : `Access to your ${devices} was blocked. Allow it in your browser's site settings, or upload a file instead.`,
      );
      return;
    }
    streamRef.current = stream;

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, {
        mimeType: mime,
        ...(wantVideo
          ? { videoBitsPerSecond: VIDEO_BITS_PER_SECOND, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
          : {}),
      });
    } catch {
      teardownCapture();
      setPhase("unsupported");
      setError("This browser refused to start a recorder. Upload an audio file instead.");
      return;
    }
    recorderRef.current = rec;
    setMimeType(rec.mimeType || mime);
    setCanPause(typeof rec.pause === "function" && typeof rec.resume === "function");

    chunksRef.current = [];
    bytesRef.current = 0;
    accumulatedRef.current = 0;
    setElapsedMs(0);
    setSizeBytes(0);
    setBlob(null);
    forcedStopRef.current = false;

    rec.ondataavailable = (ev: BlobEvent) => {
      if (!ev.data || ev.data.size === 0) return;
      chunksRef.current.push(ev.data);
      bytesRef.current += ev.data.size;
      setSizeBytes(bytesRef.current);
      if (bytesRef.current >= maxBytes && rec.state !== "inactive") {
        // Keep what we have — stopping preserves the take, and the user can still upload it.
        forcedStopRef.current = true;
        setError(
          `Recording hit the ${Math.round(maxBytes / (1024 * 1024))} MB size limit and was stopped. ` +
            "Everything recorded so far has been kept.",
        );
        rec.stop();
      }
    };
    rec.onerror = () => {
      forcedStopRef.current = true;
      setError("The recorder stopped unexpectedly. Any audio captured so far has been kept.");
      if (rec.state !== "inactive") rec.stop();
    };
    rec.onstop = () => {
      const seg = segmentStartRef.current;
      if (seg !== null) accumulatedRef.current += Date.now() - seg;
      segmentStartRef.current = null;
      setElapsedMs(accumulatedRef.current);
      teardownCapture();
      finalise(rec.mimeType || mime);
      setPhase("review");
    };

    // The level meter's analyser. Best-effort: a failure here costs a meter, never the recording,
    // so it must not be able to abort the take.
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        const ctx = new Ctor();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser); // deliberately NOT connected to destination — that would echo the mic
        analyserRef.current = analyser;
      }
    } catch {
      analyserRef.current = null;
    }

    rec.start(TIMESLICE_MS);
    if (wantVideo) setPreviewStream(stream);
    segmentStartRef.current = Date.now();
    setPhase("recording");
    startTick();
  }, [finalise, maxBytes, startTick, teardownCapture, wantVideo]);

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    rec.pause();
    const seg = segmentStartRef.current;
    if (seg !== null) accumulatedRef.current += Date.now() - seg;
    segmentStartRef.current = null;
    setElapsedMs(accumulatedRef.current);
    setLevel(0);
    setPhase("paused");
  }, []);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    rec.resume();
    segmentStartRef.current = Date.now();
    setPhase("recording");
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    // `onstop` does the rest (clock, teardown, blob assembly, phase) so that a forced stop from the
    // size guard and a user stop converge on exactly one code path.
    if (rec && rec.state !== "inactive") rec.stop();
    else {
      teardownCapture();
      setPhase(chunksRef.current.length ? "review" : "idle");
    }
  }, [teardownCapture]);

  const reset = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      // Drop the take: null the handler first so `onstop` cannot resurrect it into `review`.
      rec.onstop = null;
      rec.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    bytesRef.current = 0;
    accumulatedRef.current = 0;
    segmentStartRef.current = null;
    forcedStopRef.current = false;
    teardownCapture();
    setBlob(null);
    setSizeBytes(0);
    setElapsedMs(0);
    setError(null);
    setPhase("idle");
  }, [teardownCapture]);

  const ext = mimeType ? (EXT_BY_MIME[mimeType.split(";")[0].trim()] ?? "webm") : "webm";

  return {
    phase,
    kind: wantVideo ? "video" : "audio",
    previewStream,
    maxBytes,
    elapsedMs,
    level,
    blob,
    blobUrl,
    mimeType,
    sizeBytes,
    error,
    nearSizeLimit: sizeBytes >= maxBytes * WARN_AT_FRACTION,
    canPause,
    fileName: `meeting-recording.${ext}`,
    start,
    pause,
    resume,
    stop,
    reset,
  };
}

/** mm:ss (or h:mm:ss past an hour) from ms. Local to the recorder UI — `formatDuration` in
 *  lib/meetings.ts takes SECONDS and is used for persisted durations. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
