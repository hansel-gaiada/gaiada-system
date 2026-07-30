import "server-only";
// WS11 capture edge — meeting-recordings registry data layer. Thin readers over the platform
// meetings API (0023 / MeetingRecordingsController). Every reader DEGRADES gracefully (return
// []/null on 404/403) so the page ships ahead of the backend deploy — same pattern as lib/pipeline.ts.
//
// The desktop capture-helper is what actually records + transcribes locally; this UI is the registry
// (reference recordings, see their status + Drive state + linked pipeline run) plus a degrade-path for
// registering an externally-made recording and pasting its transcript when the helper isn't installed.
//
// BFF CONTRACT (implemented in platform-nest):
//   POST /api/:t/meetings/recordings/start        -> { id, meetingId, deduped }
//   PATCH /api/:t/meetings/recordings/:id          -> { id, status }
//   POST /api/:t/meetings/recordings/:id/transcript-> { id, status, chars }
//   POST /api/:t/meetings/recordings/:id/ingest    -> { ok, runId, deduped } | { ok:false, reason }
//   POST /api/:t/meetings/recordings/:id/drive     -> { id, driveStatus }
//   GET  /api/:t/meetings/recordings?status=&clientId=&projectId=  -> MeetingRecording[]
//   GET  /api/:t/meetings/recordings/:id           -> MeetingRecordingDetail
//   -- WD-04/WD-07 (Web Dev Phase 1 §12): the in-ERP audio-upload fallback (no capture-helper
//      required) — used when meetingsActions.ts's uploadAudioAction/retryAudioAction are called:
//   POST /api/:t/meetings/recordings/:id/audio (multipart, field "file") -> 202 { id, status:"transcribing", audioRef }
//   POST /api/:t/meetings/recordings/:id/audio/retry                    -> 202 { id, status:"transcribing" }
import { platformFetch, PlatformError } from "./platform";

export type RecordingStatus = "recording" | "recorded" | "transcribing" | "transcribed" | "ingested" | "failed";
export type DriveStatus = "none" | "pending" | "uploading" | "synced" | "failed";
export type RecordingKind = "audio" | "video";

export interface MeetingRecording {
  id: string;
  meeting_id: string;
  client_id: string | null;
  project_id: string | null;
  title: string | null;
  kind: RecordingKind;
  status: RecordingStatus;
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  size_bytes: number | null;
  drive_status: DriveStatus;
  drive_link: string | null;
  pipeline_run_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
export interface MeetingRecordingDetail extends MeetingRecording {
  local_hint: string | null;
  transcript: string | null;
  transcript_ref: string | null;
  drive_file_id: string | null;
  // WD-04: set once an in-ERP audio upload has landed (files.id); stays null on the
  // helper-driven local-whisper path (that path never uploads audio through this route).
  audio_ref: string | null;
}

export const STATUS_LABEL: Record<RecordingStatus, string> = {
  recording: "recording",
  recorded: "recorded",
  transcribing: "transcribing",
  transcribed: "transcribed",
  ingested: "in pipeline",
  failed: "failed",
};
export const DRIVE_LABEL: Record<DriveStatus, string> = {
  none: "not on Drive",
  pending: "Drive: reminder",
  uploading: "uploading…",
  synced: "on Drive",
  failed: "Drive failed",
};

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

export async function listRecordings(
  userId: string,
  tenant: string,
  opts: { status?: string; clientId?: string; projectId?: string } = {},
): Promise<MeetingRecording[]> {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.clientId) q.set("clientId", opts.clientId);
  if (opts.projectId) q.set("projectId", opts.projectId);
  const qs = q.toString();
  return safe(platformFetch<MeetingRecording[]>(`/api/${tenant}/meetings/recordings${qs ? `?${qs}` : ""}`, userId), []);
}

export async function getRecording(userId: string, tenant: string, id: string): Promise<MeetingRecordingDetail | null> {
  return safe(platformFetch<MeetingRecordingDetail>(`/api/${tenant}/meetings/recordings/${id}`, userId), null);
}

/** WD-02: resolve a run's `source_meeting_id` (the dispatcher's meetingId, NOT a recording row id —
 *  see MeetingRecordingsController.ingest, which posts `row.meeting_id`) back to its recording, so
 *  the pipeline run workspace can link to `/meetings/[id]`. There is no by-meetingId read on the
 *  registry endpoint; the volume here is small (WS11 usage), so scanning the existing list is the
 *  right-sized fix rather than a new backend query. Returns null if no recording matches (e.g. a
 *  run entered without a captured meeting). */
export async function findRecordingByMeetingId(userId: string, tenant: string, meetingId: string): Promise<MeetingRecording | null> {
  const rows = await listRecordings(userId, tenant);
  return rows.find((r) => r.meeting_id === meetingId) ?? null;
}

/** Human-friendly duration (e.g. "1h 02m", "8m 30s"). */
export function formatDuration(sec: number | null): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
