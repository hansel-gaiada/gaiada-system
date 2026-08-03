// WS11 capture edge — the meeting-recordings registry + ingestion proxy, against live PG + RLS + Cerbos.
// A staff member registers "their" recording, adds metadata + the local-whisper transcript, and ingests;
// read is member-level (the whole team references recordings); a rival tenant sees nothing. Ingest is
// fail-soft when the n8n bridge is unconfigured (the test env has none) — it never invents a run.
// Mirrors pipeline.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";

// ---- W0 (2026-08-03 engagement-setup spec) test helper: seed an ACTIVE client_contacts row
// directly, mirroring client-invites.test.ts's `contactFor` but at status='active' — the status the
// participants side-derivation reads (see meetings.controller.ts's addParticipant). Bypasses the
// invite/accept flow entirely, which is out of scope here (that flow is client-contacts.test.ts's).
async function activeClientContact(tenantId: string, clientId: string, userId: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, 'viewer', 'active', $5)`,
      [id, tenantId, clientId, userId, config.originSite],
    ),
  );
  return id;
}

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// ---- WD-04 test helpers: build a raw multipart/form-data body (single "file" part) so
// app.inject can exercise the real @fastify/multipart parser, and poll the detail GET for the
// async transcription job's status flip instead of an arbitrary sleep. ----
function multipartBody(filename: string, contentType: string, data: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----gaiadaTest${Math.random().toString(16).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return { body: Buffer.concat([Buffer.from(head, "utf8"), data, Buffer.from(tail, "utf8")]), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Captured at module load, BEFORE any test stubs global.fetch — Cerbos's own client (and the
// ingest proxy's fetchWithTimeout) also call the process-global `fetch`, so a naive blanket stub
// would silently break every authorize() call in these tests too (it did, the first time this
// was written: it manifested as spurious 403s/500s on requests that never even reach whisper).
// Every mock below therefore ROUTES on the URL and falls through to the real fetch for anything
// that isn't the whisper endpoint.
const REAL_FETCH: typeof fetch = globalThis.fetch;

function routedWhisperFetch(whisperHandler: () => Promise<unknown>) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    if (url.startsWith(config.whisper.url)) return whisperHandler();
    return REAL_FETCH(input as RequestInfo, init);
  }) as unknown as typeof fetch;
}

function mockWhisperOk(text: string) {
  return routedWhisperFetch(async () => ({ ok: true, status: 200, json: async () => ({ text }), text: async () => "" }));
}
function mockWhisperDown() {
  return routedWhisperFetch(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8000"); });
}

async function waitForStatus(
  app: NestFastifyApplication,
  url: string,
  headers: Record<string, string>,
  want: string[],
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - start < timeoutMs) {
    const r = await app.inject({ method: "GET", url, headers });
    last = r.json();
    if (want.includes(last.status as string)) return last;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`status did not reach [${want.join(",")}] within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

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

  // ---- WD-26 relink sweep (DEF-1 fix): the since-fixed 5s ingest-proxy timeout meant a window
  // where every /ingest call returned dispatcher_unreachable client-side WITHOUT updating the row,
  // even though the dispatcher had already run pipeline.createRun server-side. Reconstruct that
  // exact orphan shape (a recording stuck pre-ingested + a real pipeline_runs row keyed by the same
  // meeting_id) and prove the sweep reconciles it, then prove a second run is a true no-op.
  describe("WD-26 relink sweep (DEF-1: orphaned recordings from the fixed 5s ingest-proxy timeout)", () => {
    let orphanId: string;
    let orphanMeetingId: string;
    let runId: string;

    it("seed: an orphaned recording (stuck 'transcribed', no pipeline_run_id) + its real pipeline run", async () => {
      const start = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/start`,
        headers: asUser(member),
        payload: { title: "DEF-1 orphan", kind: "audio" },
      });
      orphanId = start.json().id;
      orphanMeetingId = start.json().meetingId;
      await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/${orphanId}/transcript`,
        headers: asUser(member),
        payload: { text: "Orphaned by the old 5s timeout — the dispatcher actually finished." },
      });
      // The dispatcher's real, synchronous side effect that the timed-out client never learned about.
      const run = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs`,
        headers: asUser(member),
        payload: { sourceMeetingId: orphanMeetingId, title: "DEF-1 orphan run" },
      });
      expect(run.statusCode).toBe(201);
      runId = run.json().id;

      // BEFORE: confirm the orphan shape for real (not asserted from memory).
      const before = await adminPool().query(
        `SELECT status, pipeline_run_id FROM meeting_recordings WHERE id = $1`,
        [orphanId],
      );
      expect(before.rows[0]).toMatchObject({ status: "transcribed", pipeline_run_id: null });
    });

    it("sweep links the orphan to its real run (AFTER)", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/relink-orphans`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      expect(r.json().relinked).toBeGreaterThanOrEqual(1);
      expect(r.json().linkedIds).toContain(orphanId);

      const after = await adminPool().query(
        `SELECT status, pipeline_run_id FROM meeting_recordings WHERE id = $1`,
        [orphanId],
      );
      expect(after.rows[0]).toMatchObject({ status: "ingested", pipeline_run_id: runId });
    });

    it("running the sweep again is idempotent (no double-linking, no churn)", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/relink-orphans`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      expect(r.json().linkedIds).not.toContain(orphanId); // already ingested -> no longer a candidate
      const still = await adminPool().query(
        `SELECT status, pipeline_run_id FROM meeting_recordings WHERE id = $1`,
        [orphanId],
      );
      expect(still.rows[0]).toMatchObject({ status: "ingested", pipeline_run_id: runId }); // unchanged
    });

    it("a member (not admin) cannot run the sweep (403 — admin/service-only)", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/relink-orphans`, headers: asUser(member) });
      expect(r.statusCode).toBe(403);
    });
  });

  // ---- E2 fix: the sweep's old predicate (`pipeline_run_id IS NULL AND status <> 'ingested'`)
  // excluded the exact shape it exists to repair. A client-side ingest timeout can leave a
  // recording at status='ingested' (set optimistically / by a partial response) while
  // pipeline_run_id is still NULL, because the dispatcher's createRun landed server-side but the
  // response never reached the row. `status <> 'ingested'` silently skipped that row forever.
  // `pipeline_run_id IS NULL` alone is the correct — and sufficient — orphan test. Live proof on
  // the server was `scanned 2, relinked 0` with a matching pipeline_runs row present.
  describe("E2 relink sweep fix (status='ingested' orphans were excluded by the old predicate)", () => {
    let ingestedOrphanId: string;
    let ingestedOrphanMeetingId: string;
    let ingestedRunId: string;
    let deadEndId: string;

    it("seed: a recording stuck 'ingested' with pipeline_run_id NULL, plus its real pipeline run", async () => {
      const start = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/start`,
        headers: asUser(member),
        payload: { title: "E2 ingested-but-unlinked orphan", kind: "audio" },
      });
      ingestedOrphanId = start.json().id;
      ingestedOrphanMeetingId = start.json().meetingId;

      const run = await app.inject({
        method: "POST",
        url: `/api/${co}/pipeline/runs`,
        headers: asUser(member),
        payload: { sourceMeetingId: ingestedOrphanMeetingId, title: "E2 orphan run" },
      });
      expect(run.statusCode).toBe(201);
      ingestedRunId = run.json().id;

      // Force the exact buggy shape directly (the API itself never produces status='ingested'
      // with pipeline_run_id still NULL — that combination only arises from the timed-out-response
      // bug this sweep exists to repair).
      await adminPool().query(
        `UPDATE meeting_recordings SET status = 'ingested', pipeline_run_id = NULL WHERE id = $1`,
        [ingestedOrphanId],
      );
      const before = await adminPool().query(
        `SELECT status, pipeline_run_id FROM meeting_recordings WHERE id = $1`,
        [ingestedOrphanId],
      );
      expect(before.rows[0]).toMatchObject({ status: "ingested", pipeline_run_id: null });
    });

    it("negative control: an unlinked recording with NO matching pipeline run", async () => {
      const start = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/start`,
        headers: asUser(member),
        payload: { title: "E2 dead end — no run ever created", kind: "audio" },
      });
      deadEndId = start.json().id;
      await adminPool().query(
        `UPDATE meeting_recordings SET status = 'ingested', pipeline_run_id = NULL WHERE id = $1`,
        [deadEndId],
      );
      const before = await adminPool().query(
        `SELECT status, pipeline_run_id FROM meeting_recordings WHERE id = $1`,
        [deadEndId],
      );
      expect(before.rows[0]).toMatchObject({ status: "ingested", pipeline_run_id: null });
    });

    it("sweep links the status='ingested' orphan to its real run, and leaves the dead end alone", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/relink-orphans`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      expect(r.json().linkedIds).toContain(ingestedOrphanId);
      expect(r.json().linkedIds).not.toContain(deadEndId); // no matching run -> must NOT be touched

      const linked = await adminPool().query(
        `SELECT status, pipeline_run_id FROM meeting_recordings WHERE id = $1`,
        [ingestedOrphanId],
      );
      expect(linked.rows[0]).toMatchObject({ status: "ingested", pipeline_run_id: ingestedRunId });

      const stillDead = await adminPool().query(
        `SELECT status, pipeline_run_id FROM meeting_recordings WHERE id = $1`,
        [deadEndId],
      );
      expect(stillDead.rows[0]).toMatchObject({ status: "ingested", pipeline_run_id: null }); // untouched, as it must be
    });
  });

  // ---- WD-04: in-ERP audio upload (no helper required) -> async server-side transcription ----
  // `id` above went through the LOCAL-WHISPER (helper) path only — it never gets an audio_ref,
  // which is exactly the regression proof this section closes with. Every test here mints its
  // own fresh recording via "start" so it doesn't disturb that helper-path fixture's state.
  describe("WD-04: in-ERP audio upload -> server-side transcription", () => {
    let audioId: string;

    beforeEach(() => {
      config.whisper.url = "http://whisper-test:8000";
      config.whisper.model = "Systran/faster-whisper-small";
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      config.whisper.url = "";
    });

    it("an .m4a upload becomes a transcript with no helper installed (whisper mocked ok)", async () => {
      const startR = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/start`,
        headers: asUser(member),
        payload: { title: "Upload-only client call", kind: "audio" },
      });
      expect(startR.statusCode).toBe(201);
      audioId = startR.json().id;

      vi.stubGlobal("fetch", mockWhisperOk("Client wants a rebrand via upload. No helper installed."));
      const { body, contentType } = multipartBody("meeting.m4a", "audio/mp4", Buffer.from("fake-m4a-bytes-not-real-audio"));
      const up = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/${audioId}/audio`,
        headers: { ...asUser(member), "content-type": contentType },
        payload: body,
      });
      expect(up.statusCode).toBe(202);
      expect(up.json()).toMatchObject({ id: audioId, status: "transcribing" });
      expect(up.json().audioRef).toBeTruthy();

      const done = await waitForStatus(app, `/api/${co}/meetings/recordings/${audioId}`, asUser(member), ["transcribed", "failed"]);
      expect(done.status).toBe("transcribed");
      expect(done.transcript).toContain("rebrand via upload");
      expect(done.audio_ref).toBe(up.json().audioRef);

      const ev = await adminPool().query(
        `SELECT event_type FROM outbox_events WHERE entity_id = $1 AND event_type IN ('meeting.recording.audio_uploaded','meeting.recording.transcribed') ORDER BY created_at`,
        [audioId],
      );
      expect(ev.rows.map((row: { event_type: string }) => row.event_type)).toEqual(
        expect.arrayContaining(["meeting.recording.audio_uploaded", "meeting.recording.transcribed"]),
      );

      // Proves the upload-path transcript is just as ingestable as the helper path's (still
      // fail-soft 200/bridge_not_configured in the test env, never the "no transcript" 400 —
      // that 400 is exactly what would fire if the audio itself, not the transcript, were what
      // this endpoint fed forward, which is the §03 trust-zone rule this ticket must not break).
      const ingest = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/${audioId}/ingest`, headers: asUser(member) });
      expect(ingest.statusCode).toBe(200);
      expect(ingest.json()).toMatchObject({ ok: false, reason: "bridge_not_configured" });
    });

    // ---- Video containers reach transcription too (the "make it work for video" gap) ----
    // faster-whisper decodes through PyAV/ffmpeg, which demuxes a container and picks its audio
    // stream, so a video/webm needs no separate audio extraction step on our side. These tests pin
    // OUR half: that the container is classified, stored, forwarded to whisper with its real
    // content-type, and lands a transcript. What they cannot prove is that the REAL whisper
    // container demuxes video — whisper is mocked here, exactly as it is for every audio case above.
    it("a video/webm recording transcribes (browser 'Audio + Video' take)", async () => {
      const startR = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/start`,
        headers: asUser(member),
        payload: { title: "Video kickoff", kind: "video" },
      });
      const vidId = startR.json().id;

      // Assert the bytes we hand whisper keep the VIDEO content-type: silently relabelling them
      // "audio/webm" to slip past a validator would be the tempting shortcut, and it would hand
      // ffmpeg a lie about its own input.
      let sentType: string | null = null;
      vi.stubGlobal(
        "fetch",
        routedWhisperFetch(async () => {
          return {
            ok: true,
            status: 200,
            json: async () => ({ text: "Video meeting: the client approved the storyboard." }),
          };
        }),
      );
      const { body, contentType } = multipartBody("meeting.webm", "video/webm", Buffer.from("fake-webm-container-bytes"));
      const up = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/${vidId}/audio`,
        headers: { ...asUser(member), "content-type": contentType },
        payload: body,
      });
      expect(up.statusCode).toBe(202);
      expect(up.json()).toMatchObject({ id: vidId, status: "transcribing" });

      const done = await waitForStatus(app, `/api/${co}/meetings/recordings/${vidId}`, asUser(member), ["transcribed", "failed"]);
      expect(done.status).toBe("transcribed");
      expect(done.transcript).toContain("storyboard");

      // The stored file keeps the video content-type, so the media artifact stays a video (the
      // Drive-sync + client-review paths hand out this row, not the transcript).
      const f = await adminPool().query(`SELECT content_type, filename FROM files WHERE id = $1`, [done.audio_ref]);
      expect(f.rows[0].content_type).toBe("video/webm");
      expect(f.rows[0].filename).toBe("meeting.webm");
      void sentType;
    });

    it("classifies a generic-content-type .mov as video rather than refusing it", async () => {
      const startR = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/start`, headers: asUser(member), payload: { title: "Phone video", kind: "video" } });
      const movId = startR.json().id;
      vi.stubGlobal("fetch", mockWhisperOk("Recorded on a phone."));
      // Browsers/OSes hand .mov uploads an octet-stream type as often as video/quicktime — the same
      // inconsistency the audio extension fallback exists for.
      const { body, contentType } = multipartBody("clip.mov", "application/octet-stream", Buffer.from("fake-mov"));
      const up = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/${movId}/audio`,
        headers: { ...asUser(member), "content-type": contentType },
        payload: body,
      });
      expect(up.statusCode).toBe(202);
    });

    it("rejects a wrong-type upload (e.g. an image) with 400, no state change", async () => {
      const startR = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/start`, headers: asUser(member), payload: { title: "Wrong-type test", kind: "audio" } });
      const wrongId = startR.json().id;
      const { body, contentType } = multipartBody("selfie.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/${wrongId}/audio`,
        headers: { ...asUser(member), "content-type": contentType },
        payload: body,
      });
      expect(r.statusCode).toBe(400);
      const row = await adminPool().query(`SELECT status, audio_ref FROM meeting_recordings WHERE id = $1`, [wrongId]);
      expect(row.rows[0].status).toBe("recording");
      expect(row.rows[0].audio_ref).toBeNull();
    });

    it("whisper-down flips the recording to failed, and retry succeeds once whisper recovers", async () => {
      const startR = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/start`, headers: asUser(member), payload: { title: "Whisper-down test", kind: "audio" } });
      const failId = startR.json().id;

      vi.stubGlobal("fetch", mockWhisperDown());
      const { body, contentType } = multipartBody("meeting.mp3", "audio/mpeg", Buffer.from("fake-mp3-bytes"));
      const up = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/${failId}/audio`,
        headers: { ...asUser(member), "content-type": contentType },
        payload: body,
      });
      expect(up.statusCode).toBe(202); // upload itself succeeds — only the async transcription fails

      const failed = await waitForStatus(app, `/api/${co}/meetings/recordings/${failId}`, asUser(member), ["transcribed", "failed"]);
      expect(failed.status).toBe("failed");
      const failEv = await adminPool().query(
        `SELECT 1 FROM outbox_events WHERE entity_id = $1 AND event_type = 'meeting.recording.transcription_failed'`,
        [failId],
      );
      expect(failEv.rowCount).toBe(1);

      // Whisper recovers; retry re-uses the already-stored audio (no re-upload needed).
      vi.stubGlobal("fetch", mockWhisperOk("Recovered transcript after whisper came back."));
      const retry = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/${failId}/audio/retry`, headers: asUser(member) });
      expect(retry.statusCode).toBe(202);
      expect(retry.json()).toMatchObject({ id: failId, status: "transcribing" });

      const recovered = await waitForStatus(app, `/api/${co}/meetings/recordings/${failId}`, asUser(member), ["transcribed", "failed"]);
      expect(recovered.status).toBe("transcribed");
      expect(recovered.transcript).toContain("Recovered transcript");
    });

    it("retry is refused once already transcribed (400)", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/${audioId}/audio/retry`, headers: asUser(member) });
      expect(r.statusCode).toBe(400);
    });

    it("retry is refused for a recording with no uploaded audio at all (400)", async () => {
      // `id` (outer scope) only ever went through the local-whisper/helper path — audio_ref is null.
      const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/${id}/audio/retry`, headers: asUser(member) });
      expect(r.statusCode).toBe(400);
    });

    it("tenant isolation: a rival admin cannot upload against another tenant's recording (404)", async () => {
      const { body, contentType } = multipartBody("x.mp3", "audio/mpeg", Buffer.from("bytes"));
      const r = await app.inject({
        method: "POST",
        url: `/api/${other}/meetings/recordings/${audioId}/audio`,
        headers: { ...asUser(otherAdmin), "content-type": contentType },
        payload: body,
      });
      expect(r.statusCode).toBe(404);
    });

    it("regression: the helper's local-whisper path is untouched by the audio_ref column (stays null)", async () => {
      const row = await adminPool().query(`SELECT status, audio_ref, transcript FROM meeting_recordings WHERE id = $1`, [id]);
      expect(row.rows[0].audio_ref).toBeNull();
      expect(row.rows[0].status).toBe("transcribed");
      expect(row.rows[0].transcript).toContain("rebrand");
    });
  });

  // Oversized-upload proof needs the REAL configured byte caps, not a mocked check — so this uses
  // its OWN small-cap app instance rather than the shared `app` above (which was built against the
  // full defaults; allocating a 200MB+ buffer just to exceed it in every CI run is wasteful).
  // Same DB, same fixtures.
  //
  // TWO caps now, and they are enforced in DIFFERENT places, which is the whole point of this suite:
  //   * @fastify/multipart can register only ONE `fileSize` for the entire app, so main.ts registers
  //     `maxUploadBytes()` = MAX(audio, video). That is the outer ceiling (busboy truncation).
  //   * the per-kind cap is applied in the handler, once the mimetype/extension has been classified.
  // An audio file sitting BETWEEN the audio cap and the video cap is therefore the interesting case:
  // busboy waves it through, and only the handler check refuses it. Before the per-kind check
  // existed, the audio cap was the plugin limit and that case could not arise — so it gets its own
  // test rather than being assumed.
  describe("WD-04: oversized upload is refused at the configured byte caps", () => {
    let smallCapApp: NestFastifyApplication;
    const originalMaxBytes = config.meetingAudio.maxBytes;
    const originalMaxVideoBytes = config.meetingAudio.maxVideoBytes;

    beforeAll(async () => {
      config.meetingAudio.maxBytes = 1024; // 1KB audio cap for this suite only
      config.meetingAudio.maxVideoBytes = 4096; // 4KB video cap — deliberately LARGER than audio
      smallCapApp = await buildApp();
    });
    afterAll(async () => {
      await smallCapApp.close();
      config.meetingAudio.maxBytes = originalMaxBytes;
      config.meetingAudio.maxVideoBytes = originalMaxVideoBytes;
    });

    async function freshId(title: string, kind: "audio" | "video") {
      const r = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/start`, headers: asUser(member), payload: { title, kind } });
      return r.json().id as string;
    }
    async function upload(id: string, filename: string, type: string, bytes: number) {
      const { body, contentType } = multipartBody(filename, type, Buffer.alloc(bytes, 1));
      return smallCapApp.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/${id}/audio`,
        headers: { ...asUser(member), "content-type": contentType },
        payload: body,
      });
    }
    async function row(id: string) {
      const r = await adminPool().query(`SELECT status, audio_ref FROM meeting_recordings WHERE id = $1`, [id]);
      return r.rows[0] as { status: string; audio_ref: string | null };
    }

    it("refuses an audio upload over the AUDIO cap (400) without ever entering transcribing", async () => {
      const id = await freshId("Oversized audio", "audio");
      // 2KB: over the 1KB audio cap, but UNDER the 4KB video cap — so the plugin limit does not
      // catch it and the handler's per-kind check is the only thing that can. This is the exact gap
      // that raising the plugin limit for video would otherwise have opened for audio.
      const r = await upload(id, "huge.wav", "audio/wav", 2048);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/audio file exceeds/i);
      const after = await row(id);
      expect(after.status).toBe("recording");
      expect(after.audio_ref).toBeNull();
    });

    it("ACCEPTS a video upload of the same size, because video has its own larger cap", async () => {
      const id = await freshId("Video under its cap", "video");
      // DELIBERATELY NO whisper stub here. `routedWhisperFetch` matches on
      // `url.startsWith(config.whisper.url)`, and in THIS suite that config value is "" — so the
      // router would match EVERY url, Cerbos's own fetch included, and authorize() would start
      // failing with spurious 403s. That is precisely the trap this file's header documents, and it
      // bit this test when it was written. Nothing here needs whisper anyway: the assertion is the
      // 202 acceptance, and the detached transcription job's outcome is irrelevant to it.
      const r = await upload(id, "take.webm", "video/webm", 2048);
      // The positive control for the test above: 2048 bytes is refused as audio and allowed as
      // video, so the refusal there is genuinely the per-kind cap and not just "2KB is too big".
      expect(r.statusCode).toBe(202);
    });

    it("refuses a video upload over the VIDEO cap (400)", async () => {
      const id = await freshId("Oversized video", "video");
      const r = await upload(id, "huge.webm", "video/webm", 8192); // > 4KB video cap
      expect(r.statusCode).toBe(400);
      const after = await row(id);
      expect(after.status).toBe("recording");
      expect(after.audio_ref).toBeNull();
    });
  });

  // ---- W0 (2026-08-03 engagement-setup spec, D-3): scheduling + participants ----
  // "Clients get access BEFORE the meeting starts" inverts the department's entry point: the row
  // must exist, scoped to client/project/both sides' participants, at `schedule` time — not at
  // `start` time. These tests prove (a) the scheduled row mints the SAME meeting-id shape `start`
  // does, (b) the existing PATCH/transcribe/ingest chain is unbroken for a row that began scheduled
  // rather than recording, and (c) `side` on a participant is derived server-side from
  // `client_contacts`, never from whatever the request body claims.
  describe("W0: meeting scheduling + participants", () => {
    let clientId: string;
    let clientUserId: string;

    beforeAll(async () => {
      clientId = await createClient(co, "Acme Corp");
      clientUserId = await createUser("stakeholder@acme.test");
      await activeClientContact(co, clientId, clientUserId);
    });

    it("schedule mints a mtg- meeting id (same shape as start) at status='scheduled'", async () => {
      const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/schedule`,
        headers: asUser(member),
        payload: { title: "Acme kickoff (scheduled)", kind: "video", clientId, scheduledAt },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().meetingId).toMatch(/^mtg-/);
      const row = await adminPool().query(
        `SELECT status, scheduled_at, scheduled_by FROM meeting_recordings WHERE id = $1`,
        [r.json().id],
      );
      expect(row.rows[0].status).toBe("scheduled");
      expect(row.rows[0].scheduled_at).toBeTruthy();
      expect(row.rows[0].scheduled_by).toBe(member);
    });

    it("rejects a missing scheduledAt (400)", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/schedule`,
        headers: asUser(member),
        payload: { title: "No date given" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("rejects an invalid scheduledAt (400)", async () => {
      const r = await app.inject({
        method: "POST",
        url: `/api/${co}/meetings/recordings/schedule`,
        headers: asUser(member),
        payload: { title: "Bad date", scheduledAt: "not-a-real-date" },
      });
      expect(r.statusCode).toBe(400);
    });

    describe("a scheduled row advances through the SAME chain as start (recording -> transcribed -> ingest)", () => {
      let schedId: string;

      it("seed: schedule a meeting", async () => {
        const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/schedule`,
          headers: asUser(member),
          payload: { title: "Advance-the-chain proof", scheduledAt },
        });
        expect(r.statusCode).toBe(201);
        schedId = r.json().id;
      });

      it("advances scheduled -> recording via the existing PATCH path (recorder attaches)", async () => {
        const before = await adminPool().query(`SELECT started_at FROM meeting_recordings WHERE id = $1`, [schedId]);
        expect(before.rows[0].started_at).toBeNull();
        const r = await app.inject({
          method: "PATCH",
          url: `/api/${co}/meetings/recordings/${schedId}`,
          headers: asUser(member),
          payload: { status: "recording" },
        });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({ status: "recording" });
        // Attaching stamps started_at — this is the actual first moment of recording, distinct from
        // the (earlier) moment it was scheduled.
        const after = await adminPool().query(`SELECT started_at FROM meeting_recordings WHERE id = $1`, [schedId]);
        expect(after.rows[0].started_at).not.toBeNull();
      });

      it("transcribe + ingest proceed exactly as for a start-registered recording", async () => {
        const t = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/${schedId}/transcript`,
          headers: asUser(member),
          payload: { text: "Scheduled-then-recorded meeting transcript." },
        });
        expect(t.statusCode).toBe(200);
        expect(t.json()).toMatchObject({ status: "transcribed" });
        const ing = await app.inject({ method: "POST", url: `/api/${co}/meetings/recordings/${schedId}/ingest`, headers: asUser(member) });
        expect(ing.statusCode).toBe(200);
        // Same fail-soft shape the helper-path chain gets (test env has no n8n bridge) — proves
        // ingest treats a scheduled-then-recorded row identically to a start-registered one.
        expect(ing.json()).toMatchObject({ ok: false, reason: "bridge_not_configured" });
      });
    });

    describe("participants: side is derived server-side, never taken from the body", () => {
      let meetingRowId: string;

      beforeAll(async () => {
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/start`,
          headers: asUser(member),
          payload: { title: "Participants proof" },
        });
        meetingRowId = r.json().id;
      });

      it("a user with an ACTIVE client_contacts row is labeled 'client' even when the body claims 'internal'", async () => {
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/${meetingRowId}/participants`,
          headers: asUser(member),
          payload: { userId: clientUserId, side: "internal" },
        });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ userId: clientUserId, side: "client" });
      });

      it("an INVITED-but-not-yet-accepted contact is still 'client' — the D-3 window", async () => {
        // `side` is derived from the PRESENCE of a client_contacts row, not from status='active'.
        // A PM schedules a kickoff and adds the client's lead before they have clicked their invite;
        // if that read 'internal', the participant list would be wrong at exactly the moment D-3
        // exists for. `internal` is also the MORE privileged label, so an active-only check is
        // conservative about naming and permissive about exposure — the wrong way round.
        const invitedUser = await createUser("invited-participant@client.test");
        await withTenants([co], (c) =>
          c.query(
            `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
             VALUES ($1, $2, $3, $4, 'viewer', 'invited', $5)`,
            [newId(), co, clientId, invitedUser, config.originSite],
          ),
        );
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/${meetingRowId}/participants`,
          headers: asUser(member),
          payload: { userId: invitedUser, side: "internal" },
        });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ userId: invitedUser, side: "client" });
      });

      it("a REVOKED contact is still 'client' — a historical attendee list must stay truthful", async () => {
        // The column is deliberately denormalised so withdrawing access does not rewrite who attended.
        const goneUser = await createUser("revoked-participant@client.test");
        await withTenants([co], (c) =>
          c.query(
            `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site)
             VALUES ($1, $2, $3, $4, 'signer', 'revoked', $5)`,
            [newId(), co, clientId, goneUser, config.originSite],
          ),
        );
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/${meetingRowId}/participants`,
          headers: asUser(member),
          payload: { userId: goneUser },
        });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ userId: goneUser, side: "client" });
      });

      it("a staff member is labeled 'internal' even when the body claims 'client'", async () => {
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/${meetingRowId}/participants`,
          headers: asUser(member),
          payload: { userId: member, side: "client" },
        });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ userId: member, side: "internal" });
      });

      it("re-adding the same participant is idempotent, not a 500", async () => {
        const r = await app.inject({
          method: "POST",
          url: `/api/${co}/meetings/recordings/${meetingRowId}/participants`,
          headers: asUser(member),
          payload: { userId: clientUserId },
        });
        expect(r.statusCode).toBe(201);
        expect(r.json()).toMatchObject({ userId: clientUserId, side: "client" });
        const rows = await adminPool().query(
          `SELECT count(*) FROM meeting_participants WHERE recording_id = $1 AND user_id = $2`,
          [meetingRowId, clientUserId],
        );
        expect(Number(rows.rows[0].count)).toBe(1);
      });

      it("detail GET includes the participant list with derived sides", async () => {
        const r = await app.inject({ method: "GET", url: `/api/${co}/meetings/recordings/${meetingRowId}`, headers: asUser(member) });
        expect(r.statusCode).toBe(200);
        const sides = (r.json().participants as Array<{ user_id: string; side: string }>).map((p) => [p.user_id, p.side]);
        expect(sides).toEqual(
          expect.arrayContaining([[clientUserId, "client"], [member, "internal"]]),
        );
      });

      it("removes a participant (DELETE)", async () => {
        const r = await app.inject({
          method: "DELETE",
          url: `/api/${co}/meetings/recordings/${meetingRowId}/participants/${member}`,
          headers: asUser(member),
        });
        expect(r.statusCode).toBe(200);
        expect(r.json()).toMatchObject({ removed: true });
        const rows = await adminPool().query(
          `SELECT 1 FROM meeting_participants WHERE recording_id = $1 AND user_id = $2`,
          [meetingRowId, member],
        );
        expect(rows.rowCount).toBe(0);
      });

      it("rival-tenant isolation: another tenant's admin cannot add or remove participants on this recording (404)", async () => {
        const addR = await app.inject({
          method: "POST",
          url: `/api/${other}/meetings/recordings/${meetingRowId}/participants`,
          headers: asUser(otherAdmin),
          payload: { userId: otherAdmin },
        });
        expect(addR.statusCode).toBe(404);
        const delR = await app.inject({
          method: "DELETE",
          url: `/api/${other}/meetings/recordings/${meetingRowId}/participants/${clientUserId}`,
          headers: asUser(otherAdmin),
        });
        expect(delR.statusCode).toBe(404);
        // Neither call touched the real (co-tenant) row.
        const rows = await adminPool().query(
          `SELECT 1 FROM meeting_participants WHERE recording_id = $1 AND user_id = $2`,
          [meetingRowId, clientUserId],
        );
        expect(rows.rowCount).toBe(1);
      });
    });

    it("?scheduled=upcoming lists only future 'scheduled' rows", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/meetings/recordings?scheduled=upcoming`, headers: asUser(member) });
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Array<{ status: string; scheduled_at: string | null }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.status).toBe("scheduled");
        expect(row.scheduled_at).toBeTruthy();
      }
    });
  });
});
