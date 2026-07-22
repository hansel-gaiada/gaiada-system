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
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";

const KINDS = new Set(["audio", "video"]);
const STATUSES = new Set(["recording", "recorded", "transcribing", "transcribed", "ingested", "failed"]);

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

@Controller("api")
@UseGuards(AuthGuard)
export class MeetingRecordingsController {
  // ---- Register + advance ----
  @Post(":tenantId/meetings/recordings/start")
  @HttpCode(201)
  async start(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { title?: string; kind?: string; clientId?: string; projectId?: string; meetingId?: string },
  ) {
    const { title, kind = "audio", clientId, projectId } = body ?? {};
    if (!KINDS.has(kind)) throw new BadRequestException("kind must be audio|video");
    await authorize(req.principal, { kind: "meeting_recording", tenantId }, "create");
    // Mint a stable meeting id (the frozen-contract dedupe key) unless the caller supplied one.
    const meetingId = body?.meetingId ?? `mtg-${newId()}`;
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
           (id, tenant_id, meeting_id, client_id, project_id, title, kind, status, started_at, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'recording', now(), $8, $9)`,
        [id, tenantId, meetingId, clientId ?? null, projectId ?? null, title ?? null, kind, req.principal.userId, config.originSite],
      );
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.created", { meetingId, kind });
      return { id, meetingId, deduped: false };
    });
    await writeActivity(tenantId, req.principal.userId, "started", "meeting_recording", result.id, { meetingId, kind });
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
           updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, meeting_id, title, kind, status, transcript, pipeline_run_id, drive_status`,
        [id, body?.status ?? null, body?.title ?? null, body?.endedAt ?? null, body?.durationSec ?? null, body?.sizeBytes ?? null, body?.localHint ?? null],
      );
      if (res.rowCount === 0) return null;
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.updated", { status: res.rows[0].status });
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
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.transcribed", { chars: text.length });
      return res.rows[0];
    });
    if (!updated) throw new NotFoundException("recording not found");
    await writeActivity(tenantId, req.principal.userId, "transcribed", "meeting_recording", id, {});
    return { id, status: "transcribed", chars: text.length };
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
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.ingested", { runId: link, deduped: dispatch.deduped ?? false });
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
      await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.drive", { driveStatus: status });
      return res.rows[0];
    });
    if (!updated) throw new NotFoundException("recording not found");
    return { id, driveStatus: status };
  }

  // ---- Registry reads ----
  @Get(":tenantId/meetings/recordings")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("status") status?: string,
    @Query("clientId") clientId?: string,
    @Query("projectId") projectId?: string,
  ) {
    await authorize(req.principal, { kind: "meeting_recording", tenantId }, "read");
    const clauses: string[] = ["deleted_at IS NULL"];
    const args: unknown[] = [];
    if (status) clauses.push(`status = $${args.push(status)}`);
    if (clientId) clauses.push(`client_id = $${args.push(clientId)}`);
    if (projectId) clauses.push(`project_id = $${args.push(projectId)}`);
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT id, meeting_id, client_id, project_id, title, kind, status, started_at, ended_at,
                duration_sec, size_bytes, drive_status, drive_link, pipeline_run_id, created_by, created_at, updated_at
         FROM meeting_recordings WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 200`,
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
        `SELECT id, meeting_id, client_id, project_id, title, kind, status, started_at, ended_at,
                duration_sec, size_bytes, local_hint, transcript, transcript_ref, drive_status,
                drive_file_id, drive_link, pipeline_run_id, created_by, created_at, updated_at
         FROM meeting_recordings WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("recording not found");
    return rows.rows[0];
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
