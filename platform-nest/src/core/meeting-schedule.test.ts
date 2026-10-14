// DW-8g (FRONTEND-BFF-CONTRACT §47.3) — the ONE code path that writes a `scheduled` meeting_recordings row. `POST
// …/meetings/recordings/schedule` and the calendar's `record: true` both go through `scheduleRecordingInTx`; this file pins the
// SQL and the event it writes EXACTLY as the schedule route wrote them before the extraction (so the route's behaviour is
// unchanged), and pins, from the sources, that both callers use the function and that nothing else inserts a `scheduled` row.
// No database: the client is a recorder. The route's HTTP proof is meetings.test.ts (Linux gate).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import { config } from "../config";
import { mintMeetingId, scheduleRecordingInTx } from "./meeting-schedule";

function recorder() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; } } as unknown as PoolClient;
  return { client, calls };
}

const T = "0190a000-0000-7000-8000-0000000000cc";
const ID = "0190a000-0000-7000-8000-0000000000dd";
const U = "0190a000-0000-7000-8000-0000000000ee";

describe("scheduleRecordingInTx", () => {
  it("writes the scheduled row exactly as the schedule route always did, then emits meeting.recording.scheduled", async () => {
    const { client, calls } = recorder();
    const when = new Date("2026-10-20T01:00:00.000Z");
    const out = await scheduleRecordingInTx(client, {
      tenantId: T, id: ID, meetingId: "mtg-fixed", title: "Kickoff", kind: "audio", clientId: null, projectId: null, scheduledAt: when, userId: U,
    });
    expect(out).toEqual({ id: ID, meetingId: "mtg-fixed", scheduledAt: "2026-10-20T01:00:00.000Z" });
    expect(calls.length).toBe(2);

    expect(calls[0].sql.replace(/\s+/g, " ").trim()).toBe(
      "INSERT INTO meeting_recordings (id, tenant_id, meeting_id, client_id, project_id, title, kind, status, scheduled_at, scheduled_by, created_by, origin_site) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8, $9, $10, $11)",
    );
    expect(calls[0].params).toEqual([ID, T, "mtg-fixed", null, null, "Kickoff", "audio", "2026-10-20T01:00:00.000Z", U, U, config.originSite]);

    // the outbox row: entity meeting_recording, event meeting.recording.scheduled, the payload the route always sent
    expect(calls[1].sql).toContain("INSERT INTO outbox_events");
    expect(calls[1].params[2]).toBe("meeting_recording");
    expect(calls[1].params[3]).toBe(ID);
    expect(calls[1].params[4]).toBe("meeting.recording.scheduled");
    expect(JSON.parse(calls[1].params[5] as string)).toEqual({
      meetingId: "mtg-fixed", kind: "audio", scheduledAt: "2026-10-20T01:00:00.000Z", actorId: U,
    });
  });

  it("carries a client and a project through, and a missing title as NULL", async () => {
    const { client, calls } = recorder();
    await scheduleRecordingInTx(client, {
      tenantId: T, id: ID, meetingId: "m", title: null, kind: "video", clientId: "c1", projectId: "p1", scheduledAt: new Date(0), userId: null,
    });
    expect(calls[0].params.slice(3, 7)).toEqual(["c1", "p1", null, "video"]);
    expect(calls[0].params.slice(8, 10)).toEqual([null, null]);
  });

  it("mintMeetingId honours an explicit id and otherwise mints `mtg-<uuid>`", () => {
    expect(mintMeetingId("helper-retry-1")).toBe("helper-retry-1");
    expect(mintMeetingId()).toMatch(/^mtg-[0-9a-f-]{36}$/);
  });
});

describe("one code path (static)", () => {
  const src = (f: string) => readFileSync(join(__dirname, f), "utf8");
  it("the schedule route and the calendar's record:true both call scheduleRecordingInTx", () => {
    expect(src("meetings.controller.ts")).toContain("scheduleRecordingInTx(c, {");
    expect(src("calendar-events.controller.ts")).toContain("scheduleRecordingInTx(c, {");
  });

  it("nothing outside meeting-schedule.ts inserts a 'scheduled' recording row", () => {
    for (const f of ["meetings.controller.ts", "calendar-events.controller.ts", "calendar-events.service.ts"]) {
      expect(src(f), f).not.toMatch(/INSERT INTO meeting_recordings[\s\S]{0,400}'scheduled'/);
    }
    expect(src("meeting-schedule.ts")).toMatch(/INSERT INTO meeting_recordings[\s\S]{0,400}'scheduled'/);
  });

  it("the schedule route keeps its order: validate, authorize meeting_recording create, mint, write, then the activity", () => {
    const s = src("meetings.controller.ts");
    const route = s.slice(s.indexOf('@Post(":tenantId/meetings/recordings/schedule")'), s.indexOf('@Patch(":tenantId/meetings/recordings/:id")'));
    const order = ['kind must be audio|video', 'scheduledAt must be a valid date/time', '"meeting_recording", tenantId }, "create"', "mintMeetingId(body?.meetingId)", "scheduleRecordingInTx(c, {", "recordingScheduledActivity("];
    let at = -1;
    for (const needle of order) {
      const i = route.indexOf(needle);
      expect(i, needle).toBeGreaterThan(at);
      at = i;
    }
  });
});
