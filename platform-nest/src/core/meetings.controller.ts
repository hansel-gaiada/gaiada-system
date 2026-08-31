// WS11 capture edge (plan 2026-07-20). The meeting-recordings registry + the ingestion PROXY.
//
// The desktop capture-helper records a client meeting locally, transcribes it with the local whisper
// service, and drives this surface: start (mint a stable meetingId) -> update (metadata on stop) ->
// transcript (store the .txt) -> ingest. INGEST IS PROXIED HERE: platform-nest — not the helper —
// holds N8N_BRIDGE_SECRET and POSTs the WS11 frozen contract to the dispatcher, so the bridge secret
// never leaves the server. Only the transcript text crosses into the pipeline; the heavy media stays
// local and is synced to the company Shared Drive separately + non-blocking (sync_drive).
//
// Backbone rule holds: n8n orchestrates, this service holds the durable state + the outbound proxy.
// Auth mirrors deliverable (any staff member registers "their" recording); read is member-level so the
// whole team can reference recordings. Every state change emits a `meeting.recording.*` event.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { storage } from "./storage";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";

const KINDS = new Set(["audio", "video"]);
// W0 (2026-08-03 engagement-setup spec, migration 0072): 'scheduled' is the pre-recording state —
// a meeting row that exists before anyone presses record, per D-3. Widened here to match the DB
// CHECK constraint (0072 §4); leaving this set behind the DB would make every scheduled row
// unreachable through `update()`'s validation despite being perfectly legal in the database.
const STATUSES = new Set(["scheduled", "recording", "recorded", "transcribing", "transcribed", "ingested", "failed"]);

/** Mint the stable meeting id — the frozen-contract dedupe key `start` has always used. Both
 *  `start` and `schedule` (W0) go through this ONE function so the two entry points can never
 *  diverge in shape; a caller-supplied id is honoured as-is (helper retry / explicit id). */
function mintMeetingId(explicit?: string): string {
  return explicit ?? `mtg-${newId()}`;
}

type Row = {
  id: string;
  meeting_id: string;
  title: string | null;
  kind: string;
  status: string;
  transcript: string | null;
  pipeline_run_id: string | null;
  drive_status: string;
};

// ---- WD-04: in-ERP audio upload -> server-side transcription (design §04/§06/§12) ----
// Type allowlist: an .m4a from a browser file input reports wildly inconsistent content-types
// (audio/mp4, audio/x-m4a, or a generic octet-stream depending on OS/browser), so a genuine
// audio/* mimetype is accepted outright, and the generic/empty-type case falls back to the file
// extension — but NEVER the reverse (a wrong-type upload with a spoofed .m4a name still needs a
// plausible mimetype OR a recognized extension; something like a bare .exe is refused either way).
const ALLOWED_AUDIO_MIME = new Set([
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac",
  "audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/flac", "audio/3gpp",
]);
const ALLOWED_AUDIO_EXT = new Set(["m4a", "mp3", "aac", "wav", "oga", "flac"]);

// ---- Video containers, accepted for transcription as well as storage ----
// VERIFIED, not assumed (2026-08-03, against the running `gaiada-whisper-1`): the local
// `fedirz/faster-whisper-server` container demuxes a video container and transcribes its audio
// stream. faster-whisper decodes through PyAV/ffmpeg (`/usr/bin/ffmpeg` is present in the image),
// so it does not need a bare audio file.
//
// The probe used a CONTROL, which is what makes it evidence rather than a green light: one
// opus-only `.webm` and one vp8+opus `.webm` built by ffmpeg from the SAME 3s audio track, so the
// two files differ only by the presence of a video stream. Both returned HTTP 200 with the
// IDENTICAL transcript — same audio in, same text out, one of them wrapped in video. An h264+aac
// `.mp4` also decoded (200, and it heard the test tone). Re-run recipe: POST multipart to
// `http://whisper:8000/v1/audio/transcriptions` from inside the compose network (whisper publishes
// no host port) — e.g. `docker exec gaiada-platform-1 node …`; prefix `MSYS_NO_PATHCONV=1` on Git
// Bash or the container path gets mangled into a Windows one.
//
// AND THE FAILURE MODE STAYS HONEST if a future image ever drops ffmpeg: `uploadAudio` stores the
// file and sets `audio_ref` BEFORE `runTranscriptionJob` runs, and that job's catch flips the row to
// `status='failed'` with the real reason while leaving the stored media intact — so the worst case
// is a failed transcription with the video preserved and the existing retry button live, never a
// lost recording and never a false success.
const ALLOWED_VIDEO_MIME = new Set([
  "video/webm", "video/mp4", "video/quicktime", "video/x-matroska", "video/ogg", "video/3gpp",
]);
const ALLOWED_VIDEO_EXT = new Set(["mov", "mkv", "ogv", "3gp", "m4v"]);

/** Extensions that are legitimately ambiguous between the two kinds (a `.webm`/`.mp4` may hold
 *  either). Classified by the mimetype when there is one; when the type is generic these fall to
 *  the LARGER (video) cap, because guessing "audio" on an actual video would refuse a valid upload
 *  while guessing "video" only allows a bigger one — the harmless direction. */
const AMBIGUOUS_EXT = new Set(["webm", "mp4", "ogg"]);

const GENERIC_CONTENT_TYPES = new Set(["application/octet-stream", ""]);

export type MediaKind = "audio" | "video";

/** Classify an upload, or null to refuse it.
 *
 *  Unchanged from the audio-only predicate this replaces: a genuine `audio/*` (or now `video/*`)
 *  mimetype is accepted outright, and the generic/empty-type case falls back to the extension — but
 *  NEVER the reverse, so a spoofed name with an implausible type is still refused, and a bare `.exe`
 *  is refused either way. */
function classifyMedia(contentType: string, filename: string): MediaKind | null {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ALLOWED_AUDIO_MIME.has(ct)) return "audio";
  if (ALLOWED_VIDEO_MIME.has(ct)) return "video";
  if (GENERIC_CONTENT_TYPES.has(ct)) {
    if (ALLOWED_AUDIO_EXT.has(ext)) return "audio";
    if (ALLOWED_VIDEO_EXT.has(ext)) return "video";
    if (AMBIGUOUS_EXT.has(ext)) return "video"; // see AMBIGUOUS_EXT
  }
  return null;
}

/** The applicable byte cap. Video gets its own, larger one; both are env-tunable. */
function maxBytesFor(kind: MediaKind): number {
  return kind === "video" ? config.meetingAudio.maxVideoBytes : config.meetingAudio.maxBytes;
}

/** The OUTER ceiling registered with @fastify/multipart, which can carry only one fileSize for the
 *  whole app. Exported so main.ts and this controller cannot drift apart — if the registration used
 *  the audio cap while video were allowed to be larger, every big video would be truncated into a
 *  confusing 400 that named a cap it had not exceeded. */
export function maxUploadBytes(): number {
  return Math.max(config.meetingAudio.maxBytes, config.meetingAudio.maxVideoBytes);
}

/** Calls the whisper container's OpenAI-compatible endpoint DIRECTLY (not via ai-gateway-go) —
 *  meeting-length audio would exceed the gateway's ~2.5-min per-call timeout (design §09).
 *  Exported for direct unit coverage; the controller drives it as a fire-and-forget job so the
 *  upload request never blocks on a full transcription. */
export async function transcribeWithWhisper(buf: Buffer, filename: string, contentType: string): Promise<string> {
  if (!config.whisper.url) throw new Error("whisper not configured (WHISPER_URL unset)");
  const form = new FormData();
  form.append("model", config.whisper.model);
  form.append("response_format", "json");
  // Buffer<ArrayBufferLike> isn't assignable to BlobPart's ArrayBufferView<ArrayBuffer> (Node's
  // Buffer type admits SharedArrayBuffer backing); a fresh Uint8Array copy is unambiguously
  // ArrayBuffer-backed and satisfies the DOM lib type.
  form.append("file", new Blob([new Uint8Array(buf)], { type: contentType }), filename);
  const res = await fetchWithTimeout(
    `${config.whisper.url.replace(/\/$/, "")}/v1/audio/transcriptions`,
    { method: "POST", body: form as unknown as BodyInit },
    config.whisper.timeoutMs,
  );
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json().catch(() => ({}));
  if (typeof (j as { text?: unknown })?.text !== "string") throw new Error("whisper: response missing text field");
  return (j as { text: string }).text.trim();
}

/** The async transcription job: never awaited by the request handler. Always resolves — its own
 *  failure path (whisper down/erroring/malformed) flips the row to 'failed' rather than throwing
 *  past the caller, so a fire-and-forget `void job.catch(...)` at the call site is a pure safety
 *  net for a bug in the failure path itself, never the expected error path. */
async function runTranscriptionJob(tenantId: string, id: string, fileId: string, buf: Buffer, contentType: string, filename: string): Promise<void> {
  try {
    const text = await transcribeWithWhisper(buf, filename, contentType);
    await withTenants([tenantId], async (c) => {
      const res = await c.query(
        `UPDATE meeting_recordings SET transcript = $2, transcript_ref = $3, status = 'transcribed', updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, text, fileId],
      );
      if (res.rowCount) {
        // TR-31: deliberately NO actorId — this fires from the detached transcription job
        // (runTranscriptionJob), which has no request/principal in scope at all; actorExternal
        // names the real (non-person) origin instead of guessing at an uploader.
        await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.transcribed", { chars: text.length, via: "upload", actorExternal: "whisper-worker" });
      }
    });
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 300);
    await withTenants([tenantId], async (c) => {
      const res = await c.query(
        `UPDATE meeting_recordings SET status = 'failed', updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id],
      );
      if (res.rowCount) {
        // TR-31: same no-principal job context as the success path above.
        await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.transcription_failed", { reason, actorExternal: "whisper-worker" });
      }
    });
  }
}

@Controller("api")
@UseGuards(AuthGuard)
export class MeetingRecordingsController {
  // ---- Register + advance ----
  @Post(":tenantId/meetings/recordings/start")
  @HttpCode(201)
  async start(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { title?: string; kind?: string; clientId?: string; projectId?: string; departmentId?: string; meetingId?: string },
  ) {
    const { title, kind = "audio", clientId, projectId, departmentId } = body ?? {};
    if (!KINDS.has(kind)) throw new BadRequestException("kind must be audio|video");
    await authorize(req.principal, { kind: "meeting_recording", tenantId }, "create");
    // Mint a stable meeting id (the frozen-contract dedupe key) unless the caller supplied one.
    const meetingId = mintMeetingId(body?.meetingId);
    const id = newId();
    const result = await withTenants([tenantId], async (c) => {
      // Idempotent start: a helper retry with the same meetingId returns the existing recording.
      const existing = await c.query<{ id: string }>(
        `SELECT id FROM meeting_recordings WHERE meeting_id = $1 AND deleted_at IS NULL`,
        [meetingId],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id, meetingId, deduped: true };
      await c.query(
        `INSERT INTO meeting_recordings
           (id, tenant_id, meeting_id, client_id, project_id, department_id, title, kind, status, started_at, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'recording', now(), $9, $10)`,
        [id, tenantId, meetingId, clientId ?? null, projectId ?? null, departmentId ?? null, title ?? null, kind, req.principal.userId, config.originSite],
      );
      // TR-31: actorId is the registering user (a genuine per-request principal, unlike the
      // async transcription job below, which has none). The consumer's mapMeetingRecording still
      // buckets `source: "system"` (categorization, unrelated to actor attribution) — see that
      // mapper's header comment.
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.created", { meetingId, kind, actorId: req.principal.userId });
      return { id, meetingId, deduped: false };
    });
    await writeActivity(tenantId, req.principal.userId, "started", "meeting_recording", result.id, { meetingId, kind });
    return result;
  }

  // ---- W0 (2026-08-03 engagement-setup spec, D-3): schedule BEFORE anyone presses record ----
  // Creates the SAME registry row `start` does, just earlier in its life and at status='scheduled'
  // instead of 'recording'. Mints the meeting id through the same `mintMeetingId` helper `start`
  // uses, so the two entry points can never diverge on the frozen-contract dedupe key's shape. The
  // recorder attaches to this row later via the existing PATCH path (see `update` below) — there is
  // no separate "convert a scheduled meeting into a recording" endpoint.
  @Post(":tenantId/meetings/recordings/schedule")
  @HttpCode(201)
  async schedule(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { title?: string; kind?: string; clientId?: string; projectId?: string; scheduledAt?: string; meetingId?: string },
  ) {
    const { title, kind = "audio", clientId, projectId, scheduledAt } = body ?? {};
    if (!KINDS.has(kind)) throw new BadRequestException("kind must be audio|video");
    const scheduledDate = scheduledAt ? new Date(scheduledAt) : null;
    if (!scheduledDate || Number.isNaN(scheduledDate.getTime())) {
      throw new BadRequestException("scheduledAt must be a valid date/time");
    }
    // Same action as `start` uses (Cerbos's meeting_recording policy defines create/update/read/
    // ingest/sync_drive/relink — no separate "schedule" action, and this ticket is not authorised
    // to add one): scheduling is, authorization-wise, registering a new meeting row.
    await authorize(req.principal, { kind: "meeting_recording", tenantId }, "create");
    const meetingId = mintMeetingId(body?.meetingId);
    const id = newId();
    const result = await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO meeting_recordings
           (id, tenant_id, meeting_id, client_id, project_id, title, kind, status, scheduled_at, scheduled_by, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8, $9, $10, $11)`,
        [id, tenantId, meetingId, clientId ?? null, projectId ?? null, title ?? null, kind, scheduledDate.toISOString(), req.principal.userId, req.principal.userId, config.originSite],
      );
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.scheduled", {
        meetingId, kind, scheduledAt: scheduledDate.toISOString(), actorId: req.principal.userId,
      });
      return { id, meetingId, scheduledAt: scheduledDate.toISOString() };
    });
    await writeActivity(tenantId, req.principal.userId, "scheduled", "meeting_recording", result.id, { meetingId, scheduledAt: result.scheduledAt });
    return result;
  }

  @Patch(":tenantId/meetings/recordings/:id")
  async update(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { status?: string; title?: string; endedAt?: string; durationSec?: number; sizeBytes?: number; localHint?: string },
  ) {
    if (body?.status !== undefined && !STATUSES.has(body.status)) throw new BadRequestException("invalid status");
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "update");
    const updated = await withTenants([tenantId], async (c) => {
      const res = await c.query<Row>(
        `UPDATE meeting_recordings SET
           status = COALESCE($2, status),
           title = COALESCE($3, title),
           ended_at = COALESCE($4, ended_at),
           duration_sec = COALESCE($5, duration_sec),
           size_bytes = COALESCE($6, size_bytes),
           local_hint = COALESCE($7, local_hint),
           -- W0: the recorder attaching to a 'scheduled' row (D-3) is the FIRST moment recording
           -- actually starts — start() stamps started_at at insert time, but a scheduled row was
           -- inserted earlier with no started_at at all. Only fires when it is still unset, so every
           -- pre-existing transition (which already has started_at from start()) is untouched.
           started_at = CASE WHEN $2 = 'recording' AND started_at IS NULL THEN now() ELSE started_at END,
           updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, meeting_id, title, kind, status, transcript, pipeline_run_id, drive_status`,
        [id, body?.status ?? null, body?.title ?? null, body?.endedAt ?? null, body?.durationSec ?? null, body?.sizeBytes ?? null, body?.localHint ?? null],
      );
      if (res.rowCount === 0) return null;
      // TR-31: actorId is the request principal.
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.updated", { status: res.rows[0].status, actorId: req.principal.userId });
      return res.rows[0];
    });
    if (!updated) throw new NotFoundException("recording not found");
    return { id, status: updated.status };
  }

  // ---- Transcript (local whisper output) ----
  @Post(":tenantId/meetings/recordings/:id/transcript")
  @HttpCode(200)
  async setTranscript(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { text?: string; ref?: string },
  ) {
    const text = body?.text;
    if (!text || !text.trim()) throw new BadRequestException("text required");
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "update");
    const updated = await withTenants([tenantId], async (c) => {
      const res = await c.query<Row>(
        `UPDATE meeting_recordings SET transcript = $2, transcript_ref = COALESCE($3, transcript_ref),
           status = 'transcribed', updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, meeting_id, title, kind, status, transcript, pipeline_run_id, drive_status`,
        [id, text, body?.ref ?? null],
      );
      if (res.rowCount === 0) return null;
      // TR-31: actorId is the request principal (manual transcript submission, not the async job).
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.transcribed", { chars: text.length, actorId: req.principal.userId });
      return res.rows[0];
    });
    if (!updated) throw new NotFoundException("recording not found");
    await writeActivity(tenantId, req.principal.userId, "transcribed", "meeting_recording", id, {});
    return { id, status: "transcribed", chars: text.length };
  }

  // ---- WD-04: in-ERP audio upload (no helper required) -> async server-side transcription ----
  // multipart/form-data, single field "file". Never blocks on the transcription itself: the
  // response returns as soon as the bytes are validated + stored, with status 'transcribing';
  // the whisper call runs as a detached job that flips the row to 'transcribed' or 'failed'.
  @Post(":tenantId/meetings/recordings/:id/audio")
  @HttpCode(202)
  async uploadAudio(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "update");
    const existing = await withTenants([tenantId], (c) =>
      c.query<{ id: string }>(`SELECT id FROM meeting_recordings WHERE id = $1 AND deleted_at IS NULL`, [id]),
    );
    if (!existing.rows[0]) throw new NotFoundException("recording not found");

    let mp: Awaited<ReturnType<NonNullable<FastifyRequest["file"]>>>;
    try {
      mp = await req.file?.();
    } catch {
      throw new BadRequestException("expected multipart/form-data with a single 'file' field");
    }
    if (!mp) throw new BadRequestException("audio file required (multipart field 'file')");
    let buf: Buffer;
    try {
      buf = await mp.toBuffer();
    } catch {
      // @fastify/multipart's toBuffer() throws FST_REQ_FILE_TOO_LARGE once the stream is
      // truncated at the registered fileSize limit (main.ts's `throwFileSizeLimit` default is
      // true) — surface it as the same clean 400 the rest of this controller uses for
      // validation failures, not a raw 413 plugin error.
      // The registered limit is now the LARGER of the two caps (main.ts), so this message names it
      // as the outer ceiling; the per-kind cap is enforced just below, once the kind is known.
      throw new BadRequestException(`file exceeds the ${maxUploadBytes()}-byte cap`);
    }
    if (buf.byteLength === 0) throw new BadRequestException("empty file");
    const contentType = mp.mimetype || "application/octet-stream";
    const filename = mp.filename || "audio";
    const kind = classifyMedia(contentType, filename);
    if (!kind) throw new BadRequestException(`unsupported audio/video type: ${contentType || filename}`);
    // Per-kind cap. The multipart limit can only enforce ONE number for the whole app, so an audio
    // upload between the audio cap and the (larger) video cap would otherwise sail past — the kind
    // is not knowable until the part's headers have been read.
    const kindCap = maxBytesFor(kind);
    if (buf.byteLength > kindCap) {
      throw new BadRequestException(`${kind} file exceeds the ${kindCap}-byte cap`);
    }

    const fileId = newId();
    const storageKey = `${tenantId}/meeting-audio/${fileId}`;
    await storage().put(storageKey, buf);
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
         VALUES ($1, $2, $3, 'meeting_recording', $4, $5, $6, $7, $8, false, $9)`,
        [fileId, tenantId, req.principal.userId, id, filename, contentType, buf.byteLength, storageKey, config.originSite],
      );
      await c.query(
        `UPDATE meeting_recordings SET audio_ref = $2, status = 'transcribing', updated_at = now() WHERE id = $1`,
        [id, fileId],
      );
      // TR-31: actorId is the uploading request principal.
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.audio_uploaded", { fileId, byteSize: buf.byteLength, contentType, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "uploaded_audio", "meeting_recording", id, { fileId, byteSize: buf.byteLength });

    // Fire-and-forget: runTranscriptionJob never throws past its own try/catch (see above), so
    // this .catch is a safety net for a bug in the failure path itself, not the expected error path.
    void runTranscriptionJob(tenantId, id, fileId, buf, contentType, filename).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[meetings] transcription job crashed unexpectedly for recording ${id}:`, err);
    });

    return { id, status: "transcribing", audioRef: fileId };
  }

  // Retry after a 'failed' transcription, re-using the already-uploaded audio (no re-upload).
  @Post(":tenantId/meetings/recordings/:id/audio/retry")
  @HttpCode(202)
  async retryAudioTranscription(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "update");
    const rec = await withTenants([tenantId], (c) =>
      c.query<{ id: string; status: string; audio_ref: string | null }>(
        `SELECT id, status, audio_ref FROM meeting_recordings WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    const row = rec.rows[0];
    if (!row) throw new NotFoundException("recording not found");
    if (!row.audio_ref) throw new BadRequestException("no uploaded audio to retry — use POST .../audio first");
    if (row.status !== "failed") throw new BadRequestException(`retry only allowed from status 'failed' (current: '${row.status}')`);

    const file = await withTenants([tenantId], (c) =>
      c.query<{ storage_key: string | null; content_type: string; filename: string }>(
        `SELECT storage_key, content_type, filename FROM files WHERE id = $1 AND deleted_at IS NULL`,
        [row.audio_ref],
      ),
    );
    const f = file.rows[0];
    if (!f?.storage_key) throw new NotFoundException("stored audio not found");
    const buf = await storage().get(f.storage_key);

    await withTenants([tenantId], async (c) => {
      await c.query(`UPDATE meeting_recordings SET status = 'transcribing', updated_at = now() WHERE id = $1`, [id]);
      // TR-31: actorId is the retrying request principal.
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.transcription_retry", { actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "retried_transcription", "meeting_recording", id, { fileId: row.audio_ref });

    void runTranscriptionJob(tenantId, id, row.audio_ref, buf, f.content_type, f.filename).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[meetings] transcription retry job crashed unexpectedly for recording ${id}:`, err);
    });

    return { id, status: "transcribing" };
  }

  // ---- WD-26 relink sweep (DEF-1 fix): reconcile recordings orphaned by the since-fixed 5s
  // ingest-proxy timeout. During that window every /ingest call timed out client-side and returned
  // { ok:false, reason:'dispatcher_unreachable' } WITHOUT updating the row — even though the
  // dispatcher had already run pipeline.createRun synchronously server-side, so a real pipeline_runs
  // row exists (keyed by source_meeting_id = this recording's meeting_id) that the recording never
  // learned about. Reconciles by that exact match; admin/service-only; idempotent (only recordings
  // still missing pipeline_run_id are ever selected, so a second run over the same data is a no-op).
  @Post(":tenantId/meetings/recordings/relink-orphans")
  @HttpCode(200)
  async relinkOrphans(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "meeting_recording", tenantId }, "relink");
    return withTenants([tenantId], async (c) => {
      const orphans = await c.query<{ id: string; meeting_id: string }>(
        `SELECT id, meeting_id FROM meeting_recordings
         WHERE tenant_id = $1 AND deleted_at IS NULL AND pipeline_run_id IS NULL`,
        [tenantId],
      );
      let relinked = 0;
      const linkedIds: string[] = [];
      for (const o of orphans.rows) {
        const run = await c.query<{ id: string }>(
          `SELECT id FROM pipeline_runs WHERE tenant_id = $1 AND source_meeting_id = $2 AND deleted_at IS NULL LIMIT 1`,
          [tenantId, o.meeting_id],
        );
        const runId = run.rows[0]?.id;
        if (!runId) continue;
        await c.query(
          `UPDATE meeting_recordings SET status = 'ingested', pipeline_run_id = $2, updated_at = now() WHERE id = $1`,
          [o.id, runId],
        );
        // TR-31: deliberately NO actorId — this is an admin/service reconciliation sweep over
        // OTHER people's recordings (relinkOrphans, gated "relink"); attributing it to whoever
        // happened to run the sweep would misattribute someone else's meeting work.
        await emitEvent(c, tenantId, "meeting_recording", o.id, "meeting.recording.ingested", {
          runId, deduped: false, via: "relink_sweep", actorExternal: "pm:relink-sweep",
        });
        relinked++;
        linkedIds.push(o.id);
      }
      return { scanned: orphans.rows.length, relinked, linkedIds };
    });
  }

  // ---- Ingest: proxy the WS11 frozen contract to the dispatcher (secret stays server-side) ----
  @Post(":tenantId/meetings/recordings/:id/ingest")
  @HttpCode(200)
  async ingest(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "ingest");
    const rec = await withTenants([tenantId], (c) =>
      c.query<Row>(
        `SELECT id, meeting_id, title, kind, status, transcript, pipeline_run_id, drive_status
         FROM meeting_recordings WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    const row = rec.rows[0];
    if (!row) throw new NotFoundException("recording not found");
    if (!row.transcript || !row.transcript.trim()) throw new BadRequestException("no transcript to ingest");

    // Fail-soft, honest: if the n8n bridge isn't configured we do NOT invent a run.
    const base = config.n8nBridge.webhookBaseUrl;
    const secret = config.n8nBridge.secret;
    if (!base || !secret) {
      return { ok: false, reason: "bridge_not_configured" };
    }

    let dispatch: { ok?: boolean; runId?: string; deduped?: boolean } = {};
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/$/, "")}/webhook/mtg/recording-complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gaiada-bridge-secret": secret },
        body: JSON.stringify({ v: 1, meetingId: row.meeting_id, tenantId, title: row.title ?? undefined, transcript: row.transcript }),
      }, config.n8nBridge.timeoutMs);
      if (res.ok) dispatch = await res.json().catch(() => ({}));
      else return { ok: false, reason: `dispatcher_${res.status}` };
    } catch {
      return { ok: false, reason: "dispatcher_unreachable" };
    }

    const runId = dispatch.runId ?? null;
    await withTenants([tenantId], async (c) => {
      // Only link the run if it exists in our tables (the dispatcher creates it synchronously via
      // pipeline.createRun); a missing run leaves pipeline_run_id null rather than violating the FK.
      const known = runId ? await c.query(`SELECT 1 FROM pipeline_runs WHERE id = $1 AND deleted_at IS NULL`, [runId]) : null;
      const link = known && known.rowCount ? runId : null;
      await c.query(
        `UPDATE meeting_recordings SET status = 'ingested', pipeline_run_id = COALESCE($2, pipeline_run_id), updated_at = now()
         WHERE id = $1`,
        [id, link],
      );
      // TR-31: actorId is the request principal who triggered this ingest proxy call.
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.ingested", { runId: link, deduped: dispatch.deduped ?? false, actorId: req.principal.userId });
    });
    await writeActivity(tenantId, req.principal.userId, "ingested", "meeting_recording", id, { runId });
    return { ok: true, runId, deduped: dispatch.deduped ?? false };
  }

  // ---- Drive sync (non-blocking; records the upload result) ----
  // The actual upload to the company Shared Drive is performed by the helper/worker with the
  // service-account credentials; this records status + links so the registry reflects Drive state.
  // Marking `pending` is the "remind them" nudge; `synced` closes it.
  @Post(":tenantId/meetings/recordings/:id/drive")
  @HttpCode(200)
  async drive(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { status?: string; driveFileId?: string; driveLink?: string },
  ) {
    const status = body?.status ?? "pending";
    if (!["pending", "uploading", "synced", "failed", "none"].includes(status)) throw new BadRequestException("invalid drive status");
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "sync_drive");
    const updated = await withTenants([tenantId], async (c) => {
      const res = await c.query<{ id: string }>(
        `UPDATE meeting_recordings SET drive_status = $2, drive_file_id = COALESCE($3, drive_file_id),
           drive_link = COALESCE($4, drive_link), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, status, body?.driveFileId ?? null, body?.driveLink ?? null],
      );
      if (res.rowCount === 0) return null;
      // TR-31: actorId is the request principal recording the Drive sync result.
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.drive", { driveStatus: status, actorId: req.principal.userId });
      return res.rows[0];
    });
    if (!updated) throw new NotFoundException("recording not found");
    return { id, driveStatus: status };
  }

  // ---- W0: participants — both sides of a scheduled/recorded meeting (D-3) ----
  // `side` is ALWAYS derived server-side from `client_contacts`, NEVER taken from the request body:
  // a caller (staff or otherwise) must not be able to mislabel a client contact as internal staff,
  // or vice versa — that mislabelling is exactly what would let the wrong side see or sign something.
  //
  // DERIVED FROM PRESENCE, NOT FROM `status` — and the distinction matters twice over:
  //   * `client_contacts` existing at all is a PM's deliberate assertion of WHICH SIDE this person is
  //     on. `status` answers a different question: whether they can log in yet. Gating `side` on
  //     `status='active'` conflates them, and gets the answer wrong in exactly the window D-3 exists
  //     for — a PM schedules a kickoff and adds the client's lead BEFORE they have clicked their
  //     invite, and the participant list calls them internal staff.
  //   * `internal` is the MORE PRIVILEGED label. Anything that later branches on `side` (who sees an
  //     internal-only note or artifact) would treat that client as staff. So an `active`-only check is
  //     conservative about labelling and permissive about exposure, which is the wrong way round.
  // A `revoked` contact still reads `client` too: they WERE the client, and this column is
  // deliberately denormalised so a historical attendee list stays truthful after access is withdrawn.
  @Post(":tenantId/meetings/recordings/:id/participants")
  @HttpCode(201)
  async addParticipant(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() body: { userId?: string },
  ) {
    const userId = String(body?.userId ?? "").trim();
    if (!userId) throw new BadRequestException("userId is required");
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "update");
    const result = await withTenants([tenantId], async (c) => {
      const rec = await c.query(`SELECT id FROM meeting_recordings WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!rec.rowCount) return null;
      const contact = await c.query(
        `SELECT 1 FROM client_contacts WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [tenantId, userId],
      );
      const side = contact.rowCount ? "client" : "internal";
      // Idempotent on the (tenant_id, recording_id, user_id) unique index: a re-add must not 500 —
      // it re-derives `side` (in case the contact's status changed since the first add) rather than
      // silently no-op'ing on a stale label.
      const row = await c.query<{ id: string; side: string }>(
        `INSERT INTO meeting_participants (id, tenant_id, recording_id, user_id, side, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, recording_id, user_id) DO UPDATE SET side = EXCLUDED.side
         RETURNING id, side`,
        [newId(), tenantId, id, userId, side, config.originSite],
      );
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.participant_added", {
        userId, side: row.rows[0].side, actorId: req.principal.userId,
      });
      return { id: row.rows[0].id, userId, side: row.rows[0].side };
    });
    if (!result) throw new NotFoundException("recording not found");
    return result;
  }

  @Delete(":tenantId/meetings/recordings/:id/participants/:userId")
  @HttpCode(200)
  async removeParticipant(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Param("userId") userId: string,
  ) {
    await authorize(req.principal, { kind: "meeting_recording", id, tenantId }, "update");
    const result = await withTenants([tenantId], async (c) => {
      const rec = await c.query(`SELECT id FROM meeting_recordings WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!rec.rowCount) return null;
      const res = await c.query(
        `DELETE FROM meeting_participants WHERE tenant_id = $1 AND recording_id = $2 AND user_id = $3`,
        [tenantId, id, userId],
      );
      const removed = (res.rowCount ?? 0) > 0;
      if (removed) {
        await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.participant_removed", { userId, actorId: req.principal.userId });
      }
      return { removed };
    });
    if (!result) throw new NotFoundException("recording not found");
    return { id, userId, removed: result.removed };
  }

  // ---- Registry reads ----
  @Get(":tenantId/meetings/recordings")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    @Query("clientId") clientId?: string,
    @Query("projectId") projectId?: string,
    @Query("scheduled") scheduled?: string,
  ) {
    await authorize(req.principal, { kind: "meeting_recording", tenantId }, "read");
    const clauses: string[] = ["deleted_at IS NULL"];
    const args: unknown[] = [];
    if (status) clauses.push(`status = $${args.push(status)}`);
    if (clientId) clauses.push(`client_id = $${args.push(clientId)}`);
    if (projectId) clauses.push(`project_id = $${args.push(projectId)}`);
    // W0: "what's coming" — still 'scheduled' (not yet advanced to 'recording') and in the future.
    if (scheduled === "upcoming") clauses.push(`status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at >= now()`);
    const orderBy = scheduled === "upcoming" ? "scheduled_at ASC" : "created_at DESC";
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, meeting_id, client_id, project_id, department_id, title, kind, status, scheduled_at, scheduled_by, started_at, ended_at,
                duration_sec, size_bytes, drive_status, drive_link, pipeline_run_id, created_by, created_at, updated_at
         FROM meeting_recordings WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy} LIMIT 200`,
        args,
      ),
    );
    return rows.rows;
  }

  @Get(":tenantId/meetings/recordings/:id")
  async get(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "meeting_recording", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, meeting_id, client_id, project_id, department_id, title, kind, status, scheduled_at, scheduled_by, started_at, ended_at,
                duration_sec, size_bytes, local_hint, transcript, transcript_ref, audio_ref, drive_status,
                drive_file_id, drive_link, pipeline_run_id, created_by, created_at, updated_at
         FROM meeting_recordings WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    const row = rows.rows[0];
    if (!row) throw new NotFoundException("recording not found");
    // W0: the participant list — the register D-3's "all parties trackable" is read from.
    const participants = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT mp.user_id, mp.side, mp.created_at, u.email, u.name
         FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
         WHERE mp.recording_id = $1
         ORDER BY mp.created_at`,
        [id],
      ),
    );
    return { ...row, participants: participants.rows };
  }
}

/** fetch with an AbortController timeout (no extra deps). */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
