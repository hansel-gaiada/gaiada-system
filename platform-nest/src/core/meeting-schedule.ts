// W0 (2026-08-03 engagement-setup spec, D-3) + DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47.3): the ONE code path that writes a
// `scheduled` meeting_recordings row. Two callers use it, so they can never diverge on the row's shape, the event it emits
// or the meeting id's form:
//   * `POST /api/:t/meetings/recordings/schedule` (meetings.controller.ts) — a recording scheduled on its own;
//   * `POST /api/:t/calendar/events` with `record: true` (calendar-events.controller.ts) — a recording scheduled with an
//     event, in the SAME transaction as the event row, then linked by `calendar_events.meeting_recording_id`.
// The function takes the caller's `PoolClient`, so the INSERT and the outbox event ride in the caller's transaction. The
// caller authorizes `meeting_recording` · `create` BEFORE it calls (authorization is never done inside a transaction), and
// writes the activity row AFTER the commit (`recordingScheduledActivity`).
import type { PoolClient } from "pg";
import { newId } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { writeActivity } from "./http";

/** Mint the stable meeting id — the frozen-contract dedupe key `start` has always used. Both `start` and `schedule` (W0)
 *  go through this ONE function so the two entry points can never diverge in shape; a caller-supplied id is honoured as-is
 *  (helper retry / explicit id). */
export function mintMeetingId(explicit?: string): string {
  return explicit ?? `mtg-${newId()}`;
}

export interface ScheduleRecordingInput {
  tenantId: string;
  /** The row's id (minted by the caller so it can name it in a later statement). */
  id: string;
  meetingId: string;
  title: string | null;
  kind: string;
  clientId: string | null;
  projectId: string | null;
  scheduledAt: Date;
  /** The scheduling user: `scheduled_by`, `created_by` and the event's `actorId`. */
  userId: string | null;
}

export interface ScheduledRecording {
  id: string;
  meetingId: string;
  scheduledAt: string;
}

/** INSERT the `scheduled` row and emit `meeting.recording.scheduled`, inside the caller's transaction. */
export async function scheduleRecordingInTx(c: PoolClient, input: ScheduleRecordingInput): Promise<ScheduledRecording> {
  const { tenantId, id, meetingId, title, kind, clientId, projectId, scheduledAt, userId } = input;
  const scheduledIso = scheduledAt.toISOString();
  await c.query(
    `INSERT INTO meeting_recordings
       (id, tenant_id, meeting_id, client_id, project_id, title, kind, status, scheduled_at, scheduled_by, created_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8, $9, $10, $11)`,
    [id, tenantId, meetingId, clientId, projectId, title, kind, scheduledIso, userId, userId, config.originSite],
  );
  await emitEvent(c, tenantId, "meeting_recording", id, "meeting.recording.scheduled", {
    meetingId, kind, scheduledAt: scheduledIso, actorId: userId,
  });
  return { id, meetingId, scheduledAt: scheduledIso };
}

/** The audit row for a scheduled recording, written AFTER the transaction commits. */
export async function recordingScheduledActivity(tenantId: string, userId: string | null, result: ScheduledRecording): Promise<void> {
  await writeActivity(tenantId, userId, "scheduled", "meeting_recording", result.id, {
    meetingId: result.meetingId, scheduledAt: result.scheduledAt,
  });
}
