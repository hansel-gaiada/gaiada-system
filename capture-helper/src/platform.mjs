// BFF client — the helper drives the meeting-recordings surface I built in platform-nest
// (MeetingRecordingsController). Ingest is PROXIED server-side, so the helper never holds the
// n8n bridge secret. All calls are best-effort with clear errors; the caller decides retries.
import { config, platformHeaders } from "./config.mjs";

async function call(method, path, body) {
  // Only set content-type when there IS a body — Fastify 400s on an empty body with a JSON
  // content-type (bites body-less POSTs like /ingest).
  const headers = { ...platformHeaders() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${config.platformUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`platform ${res.status}: ${json?.error ?? text?.slice(0, 200)}`);
  return json;
}

const t = () => config.tenantId;

/** Register a recording; mints + returns a stable meetingId. kind = "audio" | "video". */
export function startRecording({ title, kind, clientId, projectId }) {
  return call("POST", `/api/${t()}/meetings/recordings/start`, { title, kind, clientId, projectId });
}

/** Attach stop metadata (duration/size/local path/status). */
export function updateRecording(id, patch) {
  return call("PATCH", `/api/${t()}/meetings/recordings/${id}`, patch);
}

/** Store the local-whisper transcript (.txt) → status transcribed. */
export function setTranscript(id, text) {
  return call("POST", `/api/${t()}/meetings/recordings/${id}/transcript`, { text });
}

/** Kick the delivery pipeline (server proxies the frozen contract). */
export function ingest(id) {
  return call("POST", `/api/${t()}/meetings/recordings/${id}/ingest`);
}

/** Record the Drive-sync state/link. status = none|pending|uploading|synced|failed. */
export function markDrive(id, status, driveLink, driveFileId) {
  return call("POST", `/api/${t()}/meetings/recordings/${id}/drive`, { status, driveLink, driveFileId });
}

export function listRecordings() {
  return call("GET", `/api/${t()}/meetings/recordings`);
}
