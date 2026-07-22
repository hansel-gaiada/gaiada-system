// WS11 capture edge — the meeting-recordings registry + ingestion proxy, against live PG + RLS + Cerbos.
// A staff member registers "their" recording, adds metadata + the local-whisper transcript, and ingests;
// read is member-level (the whole team references recordings); a rival tenant sees nothing. Ingest is
// fail-soft when the n8n bridge is unconfigured (the test env has none) — it never invents a run.
// Mirrors pipeline.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("meeting-recordings registry + ingest proxy (WS11 capture edge)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let member: string;
  let admin: string;
  let otherAdmin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    // The test env has no n8n bridge — ingest must fail soft, never invent a run.
    config.n8nBridge.webhookBaseUrl = "";
    config.n8nBridge.secret = "";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    member = await createUser("member@meetings.test");
    admin = await createUser("admin@meetings.test");
    otherAdmin = await createUser("admin@rival-meetings.test");
    await addMembership(co, member);
    await addMembership(co, admin);
    await addMembership(other, otherAdmin);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(otherAdmin, await createRole("company_admin"), "company", other);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  let id: string;
  let meetingId: string;

  it("a staff member registers a recording (start mints a stable meetingId)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/meetings/recordings/start`,
      headers: asUser(member),
      payload: { title: "Acme kickoff", kind: "video" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ deduped: false });
    id = r.json().id;
    meetingId = r.json().meetingId;
    expect(id).toBeTruthy();
    expect(meetingId).toMatch(/^mtg-/);
  });

  it("emitted meeting.recording.created to the outbox", async () => {
    const rows = await adminPool().query(
      `SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'meeting.recording.created'`,
      [id],
    );
    expect(rows.rowCount).toBe(1);
  });

  it("start is idempotent on meetingId (helper retry)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/meetings/recordings/start`,
      headers: asUser(member),
      payload: { title: "Acme kickoff (retry)", kind: "video", meetingId },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id, meetingId, deduped: true });
  });

  it("update records stop metadata", async () => {
    const r = await app.inject({
      method: "PATCH",
      url: `/api/${co}/meetings/recordings/${id}`,
      headers: asUser(member),
      payload: { status: "recorded", durationSec: 3600, sizeBytes: 250_000_000, localHint: "C:/Gaiada/Recordings/acme.mp4" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "recorded" });
  });

  it("setTranscript stores the .txt, flips to transcribed, emits an event", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/meetings/recordings/${id}/transcript`,
      headers: asUser(member),
      payload: { text: "Client wants a rebrand. Deadline end of Q3. Budget flexible." },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "transcribed" });
    const ev = await adminPool().query(
      `SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'meeting.recording.transcribed'`,
      [id],
    );
    expect(ev.rowCount).toBe(1);
  });

  it("setTranscript rejects an empty transcript (400)", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/${id}/transcript`, headers: asUser(member), payload: { text: "  " } });
    expect(r.statusCode).toBe(400);
  });

  it("ingest fails soft when the bridge is unconfigured (never invents a run)", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/${id}/ingest`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: false, reason: "bridge_not_configured" });
    // Status must NOT have advanced to ingested.
    const row = await adminPool().query(`SELECT status FROM meeting_recordings WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("transcribed");
  });

  it("drive sync records the upload result", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/meetings/recordings/${id}/drive`,
      headers: asUser(member),
      payload: { status: "synced", driveFileId: "drv-123", driveLink: "https://drive.google.com/file/d/drv-123" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ driveStatus: "synced" });
  });

  it("read is member-level (the whole team references recordings)", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/meetings/recordings`, headers: asUser(member) });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBeGreaterThanOrEqual(1);
    const detail = await app.inject({ method: "GET", url: `/api/${co}/meetings/recordings/${id}`, headers: asUser(member) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id, drive_status: "synced" });
  });

  it("tenant isolation: a rival admin sees nothing", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${other}/meetings/recordings`, headers: asUser(otherAdmin) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(0);
    const cross = await app.inject({ method: "GET", url: `/api/${other}/meetings/recordings/${id}`, headers: asUser(otherAdmin) });
    expect(cross.statusCode).toBe(404);
  });

  it("rejects invalid kind / status (400)", async () => {
    expect((await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/start`, headers: asUser(member), payload: { kind: "hologram" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/${co}/meetings/recordings/${id}`, headers: asUser(member), payload: { status: "teleporting" } })).statusCode).toBe(400);
  });
});
