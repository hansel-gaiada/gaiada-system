import "server-only";
import { readResult, type ReadResult } from "./readResult";
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

export type RecordingStatus = "scheduled" | "recording" | "recorded" | "transcribing" | "transcribed" | "ingested" | "failed";
export type DriveStatus = "none" | "pending" | "uploading" | "synced" | "failed";
export type RecordingKind = "audio" | "video";

export interface MeetingRecording {
  /** W1 (D-3): set when the meeting was SCHEDULED before it happened. Null for rows created at
   *  record time by the older `start` path. */
  scheduled_at?: string | null;
  scheduled_by?: string | null;
  id: string;
  meeting_id: string;
  client_id: string | null;
  project_id: string | null;
  /** Org-node id of the owning department (2026-08-27); null for rows that pre-date the column. */
  department_id: string | null;
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
  /** W1 (D-3): both sides' attendees. Returned by the detail read; `side` is derived server-side from
   *  client_contacts and is a fact, not a field the UI may set. */
  participants?: { user_id: string; side: "internal" | "client"; email: string | null; name: string | null }[];
}

export const STATUS_LABEL: Record<RecordingStatus, string> = {
  // W1: the pre-recording state. A `Record<RecordingStatus, …>` is exhaustive, so widening the union
  // without adding this key is a type error rather than a blank chip — which is the point.
  scheduled: "scheduled",
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

export async function listRecordings(
  userId: string,
  tenant: string,
  opts: { status?: string; clientId?: string; projectId?: string; scheduled?: "upcoming" } = {},
): Promise<ReadResult<MeetingRecording[]>> {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.clientId) q.set("clientId", opts.clientId);
  if (opts.projectId) q.set("projectId", opts.projectId);
  // Server-side filter (status='scheduled' AND scheduled_at >= now(), soonest first) — not a
  // client-side slice, so it stays correct as the registry grows.
  if (opts.scheduled) q.set("scheduled", opts.scheduled);
  const qs = q.toString();
  // AGN-3: a refused registry read is no longer indistinguishable from "no recordings". Callers get
  // the discriminated result and render `<ReadRefusal>`; `absentAsEmpty` covers the one honest
  // absence, a deployment where the meetings routes are not served at all.
  return readResult(
    platformFetch<MeetingRecording[]>(`/api/${tenant}/meetings/recordings${qs ? `?${qs}` : ""}`, userId),
    { absentAsEmpty: [] },
  );
}

export async function getRecording(
  userId: string,
  tenant: string,
  id: string,
): Promise<ReadResult<MeetingRecordingDetail | null>> {
  // A 404 on a single ITEM is a real answer ("no such recording"), so it stays inside `ok` as null —
  // see readResult.ts on why `absent` is not a variant of the refusal type. A 403 is not an answer.
  return readResult(platformFetch<MeetingRecordingDetail>(`/api/${tenant}/meetings/recordings/${id}`, userId), {
    absentAsEmpty: null,
  });
}

/** WD-02: resolve a run's `source_meeting_id` (the dispatcher's meetingId, NOT a recording row id —
 *  see MeetingRecordingsController.ingest, which posts `row.meeting_id`) back to its recording, so
 *  the pipeline run workspace can link to `/meetings/[id]`. There is no by-meetingId read on the
 *  registry endpoint; the volume here is small (WS11 usage), so scanning the existing list is the
 *  right-sized fix rather than a new backend query. Returns null if no recording matches (e.g. a
 *  run entered without a captured meeting). */
export async function findRecordingByMeetingId(userId: string, tenant: string, meetingId: string): Promise<MeetingRecording | null> {
  // Deliberately collapses a refusal to null here: this resolves a run's meeting into a LINK, and a
  // link that cannot be built is simply not rendered. The caller's own page already distinguishes a
  // refused project read (see its `projectRefused` handling), so surfacing a second refusal banner
  // for a missing crumb would be noise rather than honesty.
  const res = await listRecordings(userId, tenant);
  if (res.kind !== "ok") return null;
  return res.data.find((r) => r.meeting_id === meetingId) ?? null;
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
