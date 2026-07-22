// Local transcription — POST the recorded audio to the faster-whisper-server OpenAI-compatible
// endpoint (/v1/audio/transcriptions) and return the plain text. Called DIRECTLY (not via the AI
// Gateway) so meeting-length audio doesn't hit the gateway's ~2.5-min per-call timeout (plan §4).
// Uses the Web FormData/Blob available in Node 20+ (undici) — no external deps.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "./config.mjs";

/** Transcribe an audio (or A/V) file to text. Returns the transcript string. */
export async function transcribeFile(file) {
  const buf = await readFile(file);
  const form = new FormData();
  form.append("model", config.whisperModel);
  form.append("response_format", "json");
  // whisper-server accepts audio containers directly (it extracts the audio track from .mp4 too).
  form.append("file", new Blob([buf]), basename(file));

  const res = await fetch(`${config.whisperUrl.replace(/\/$/, "")}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (typeof j?.text !== "string") throw new Error("whisper: response missing text field");
  return j.text.trim();
}
