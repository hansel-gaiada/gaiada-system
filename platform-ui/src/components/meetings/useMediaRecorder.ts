"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// WS11 capture edge — REAL in-browser audio capture with start / pause / resume / stop, plus the
// finished blob for playback and upload. Before this hook, the ERP's "Record" buttons only
// REGISTERED a meeting row and waited for the desktop capture-helper to attach a file: there was no
// way to actually record from the browser, and therefore nothing to pause, stop or play back.
//
// AUDIO ONLY, DELIBERATELY. The server-side transcription path validates the upload against
// `ALLOWED_AUDIO_MIME` (platform-nest/src/core/meetings.controller.ts:42) which accepts `audio/webm`,
// `audio/mp4`, `audio/ogg` … and does NOT accept any `video/*` container. A browser video recording
// is `video/webm`, so it would be refused with "unsupported audio type" AFTER the whole upload had
// been sent. Rather than widen a validation allowlist on a guess about what the whisper container
// accepts, in-browser capture stays audio-only and video capture stays with the desktop helper —
// which is what the ERP copy already told users. Revisit only with a verified whisper fact.
//
// WHY A HOOK AND NOT COMPONENT STATE: three of the four hard parts here are lifecycle, not UI —
// releasing the microphone, keeping an accurate paused-aware clock, and tearing down the analyser
// graph. Those must happen on unmount and on every terminal path, so they live with the state that
// owns them.

/** Container preference order. The first supported one wins; every entry's bare type (before `;`)
 *  is in the backend's audio allowlist, which is what makes the resulting upload acceptable —
 *  `isAllowedAudio` splits on `;` so the `codecs=` suffix is irrelevant to it. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4", // Safari
];

/** Extension per container, so the filename agrees with the bytes. This matters beyond tidiness:
 *  the backend accepts a GENERIC content-type (`application/octet-stream`) only when the EXTENSION
 *  is a known audio one, so a wrong extension can turn a valid upload into a 400. */
const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

/** Mirrors `MEETING_AUDIO_MAX_BYTES` (platform-nest config default 200 MB). Enforced client-side so a
 *  long recording fails EARLY and keeps its audio, instead of being discovered at the end of a
 *  200 MB upload that the server then rejects. */
export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;
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

export interface MediaRecorderApi {
  phase: RecorderPhase;
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

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // isTypeSupported can throw on malformed input in some engines — treat as unsupported.
    }
  }
  return null;
}

export function useMediaRecorder(): MediaRecorderApi {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
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
    const mime = pickMimeType();
    if (!mime) {
      setPhase("unsupported");
      setError("This browser has no audio container we can record to. Upload a file instead.");
      return;
    }

    setPhase("requesting");
    let stream: MediaStream;
    try {
      // Browser-side cleanup is worth asking for: meeting audio is speech, and echo/noise handling
      // materially improves what whisper receives.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      // NotAllowedError (denied/dismissed) is the common case; NotFoundError means no input device.
      const name = (e as { name?: string })?.name ?? "";
      setPhase("denied");
      setError(
        name === "NotFoundError" || name === "OverconstrainedError"
          ? "No microphone was found. Plug one in, or upload an audio file instead."
          : "Microphone access was blocked. Allow it in your browser's site settings, or upload an audio file instead.",
      );
      return;
    }
    streamRef.current = stream;

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime });
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
      if (bytesRef.current >= MAX_RECORDING_BYTES && rec.state !== "inactive") {
        // Keep what we have — stopping preserves the take, and the user can still upload it.
        forcedStopRef.current = true;
        setError("Recording hit the 200 MB size limit and was stopped. The audio so far has been kept.");
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
    segmentStartRef.current = Date.now();
    setPhase("recording");
    startTick();
  }, [finalise, startTick, teardownCapture]);

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
    elapsedMs,
    level,
    blob,
    blobUrl,
    mimeType,
    sizeBytes,
    error,
    nearSizeLimit: sizeBytes >= MAX_RECORDING_BYTES * WARN_AT_FRACTION,
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
