// PV4-05 — meeting minutes shared with the client, over HTTP, against real Postgres (RLS) + Cerbos. Both surfaces:
//   * STAFF  (Cerbos kind `meeting_recording`): GET/PUT :t/meetings/:id/minutes (read / update),
//             POST :t/meetings/:id/minutes/share (the NEW `share_minutes` action, refused to agents: PV-D23)
//   * PORTAL (`portal` read; isolation through portal-scope.ts + meetingMinutesInPortalScope):
//             GET :t/portal/meetings, GET :t/portal/meetings/:minutesId
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-05; finding 8; design decisions 8 and 9; PV4-Q1).
// BFF: docs/FRONTEND-BFF-CONTRACT.md §29c.
//
// This is a client-isolation ticket, so the isolation assertions are BY ID: a list that "looks right" proves nothing; a list
// that does not contain another client's minutes id does. Every write claim is checked against the stored row through
// adminPool (bypassing RLS), not inferred from a 2xx. The recording, transcript, participants and Drive link are SEEDED WITH
// MARKER STRINGS so a leak into the portal payload is a string match, not a judgement call.
//
// Needs DATABASE_URL_TEST + a Cerbos loaded with the current policies (resource_meeting_recording.yaml's `share_minutes`).
// Runs on the Linux gate; skipped elsewhere — and a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function addContact(
  tenantId: string, clientId: string, userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null } = {},
): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "signer", opts.status ?? "active", config.originSite],
    ),
  );
}

/** What a client may read of a meeting. Pinned EXACTLY: a new key is a deliberate, reviewed change. */
const PORTAL_KEYS = ["bodyMd", "id", "meetingDate", "sharedAt", "sharedBy", "title"];
const MARKERS = [
  "SECRET-TRANSCRIPT", "SECRET-TRANSCRIPT-REF", "SECRET-HINT", "SECRET-DRIVE", "SECRET-PARTICIPANT",
];

describe.skipIf(!TEST_URL)("PV4-05: meeting minutes shared with the client (staff + portal)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let clientB: string;
  let p1: string;  // clientA
  let p2: string;  // clientA
  let pB: string;  // clientB

  // client side
  let wideA: string;     // client-wide contact of A, capability VIEWER (minutes are readable by viewers)
  let scopedP1: string;  // contact of A scoped to P1 only
  let scopedP2: string;  // contact of A scoped to P2 only
  let wideB: string;     // client-wide contact of B
  let revokedA: string;  // revoked contact of A

  // staff side
  let admin: string;       // company_admin
  let member: string;      // member
  let staffViewer: string; // viewer role: read only
  let bot: string;         // member role, users.kind = 'bot'

  // meetings (all seeded straight into the table, with marker strings in every internal column)
  let mP1: string;       // A, P1
  let mP2: string;       // A, P2
  let mWide: string;     // A, NO project (client-wide)
  let mB: string;        // B, pB
  let mNoClient: string; // no client
  let mMove: string;     // A, P1: re-linked later
  let mDel: string;      // A, P1: soft-deleted later

  // minutes ids, filled as the staff PUTs create them
  const minutes: Record<string, string> = {};

  const portal = (path = "") => `/api/${co}/portal/meetings${path}`;
  const staff = (meeting: string, tail = "") => `/api/${co}/meetings/${meeting}/minutes${tail}`;

  const seedMeeting = async (title: string, clientId: string | null, projectId: string | null): Promise<string> => {
    const id = newId();
    await adminPool().query(
      `INSERT INTO meeting_recordings
         (id, tenant_id, meeting_id, client_id, project_id, title, status, started_at, transcript, transcript_ref, audio_ref,
          local_hint, drive_link, drive_status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 'transcribed', '2026-10-05T09:00:00Z', 'SECRET-TRANSCRIPT body', 'SECRET-TRANSCRIPT-REF',
               NULL, 'SECRET-HINT', 'https://drive.example/SECRET-DRIVE', 'synced', $7)`,
      [id, co, `pv405-${id}`, clientId, projectId, title, config.originSite],
    );
    const u = await createUser(`participant-${id}@agency.test`, "SECRET-PARTICIPANT");
    await adminPool().query(
      `INSERT INTO meeting_participants (id, tenant_id, recording_id, user_id, side, origin_site) VALUES ($1, $2, $3, $4, 'internal', $5)`,
      [newId(), co, id, u, config.originSite],
    );
    return id;
  };

  const put = (user: string, meeting: string, bodyMd: unknown) =>
    app.inject({ method: "PUT", url: staff(meeting), headers: asUser(user), payload: { bodyMd } });
  const share = (user: string, meeting: string) =>
    app.inject({ method: "POST", url: staff(meeting, "/share"), headers: asUser(user) });
  const row = async (meeting: string) =>
    (await adminPool().query(
      `SELECT id, status, body_md, drafted_by, updated_by, shared_at, shared_by FROM meeting_minutes WHERE meeting_recording_id = $1`, [meeting],
    )).rows[0];
  const portalIds = async (user: string, qs = "") => {
    const r = await app.inject({ method: "GET", url: portal(qs), headers: asUser(user) });
    expect(r.statusCode, `GET ${portal(qs)}: ${r.body.slice(0, 200)}`).toBe(200);
    return (r.json() as Array<{ id: string }>).map((m) => m.id);
  };
  const portalGet = (user: string, id: string) => app.inject({ method: "GET", url: portal(`/${id}`), headers: asUser(user) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("PV4-05 Agency");
    const clientRole = await createRole("client");
    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");

    clientA = await createClient(co, "PV405 Client A");
    clientB = await createClient(co, "PV405 Client B");
    p1 = await createProject(co, "PV405 A Project 1");
    p2 = await createProject(co, "PV405 A Project 2");
    pB = await createProject(co, "PV405 B Project");
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = ANY($2::uuid[])`, [clientA, [p1, p2]]);
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientB, pB]);

    const contact = async (email: string, client: string, opts: Parameters<typeof addContact>[3] = {}) => {
      const u = await createUser(email);
      await addContact(co, client, u, opts);
      await grantRole(u, clientRole, "company", co);
      return u;
    };
    wideA = await contact("wide-a@client.test", clientA, { capability: "viewer" });
    scopedP1 = await contact("scoped-p1@client.test", clientA, { capability: "signer", projectId: p1 });
    scopedP2 = await contact("scoped-p2@client.test", clientA, { capability: "viewer", projectId: p2 });
    wideB = await contact("wide-b@client.test", clientB, { capability: "viewer" });
    revokedA = await contact("revoked-a@client.test", clientA, { status: "revoked" });

    const staffUser = async (email: string, name: string, role: string) => {
      const u = await createUser(email, name);
      await addMembership(co, u);
      await grantRole(u, role, "company", co);
      return u;
    };
    admin = await staffUser("admin@agency.test", "Ada Admin", adminRole);
    member = await staffUser("member@agency.test", "Mia Member", memberRole);
    staffViewer = await staffUser("viewer@agency.test", "Vic Viewer", viewerRole);
    bot = await staffUser("bot@agency.test", "Minutes Bot", memberRole);
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);

    mP1 = await seedMeeting("Kickoff P1", clientA, p1);
    mP2 = await seedMeeting("Review P2", clientA, p2);
    mWide = await seedMeeting("Quarterly sync", clientA, null);
    mB = await seedMeeting("B kickoff", clientB, pB);
    mNoClient = await seedMeeting("Internal retro", null, null);
    mMove = await seedMeeting("Moving meeting", clientA, p1);
    mDel = await seedMeeting("Doomed meeting", clientA, p1);

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Saving a draft: staff and agents; a draft is invisible to the portal
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a member saves a draft: status stays 'draft', updated_by is the caller, drafted_by stays null (a person wrote it)", async () => {
    const r = await put(member, mP1, "## Kickoff\n- agreed the launch date");
    expect(r.statusCode).toBe(200);
    const out = r.json() as { clientId: string; shareable: boolean; minutes: { id: string; status: string; bodyMd: string; clientVisible: boolean } };
    // Recorded FIRST: later tests need the real id even if an assertion below fails, so one broken rule cannot make the
    // isolation tests pass vacuously by probing `/portal/meetings/undefined`.
    minutes.P1 = out.minutes.id;
    expect(out.clientId).toBe(clientA);
    expect(out.shareable).toBe(true);
    expect(out.minutes).toMatchObject({ status: "draft", bodyMd: "## Kickoff\n- agreed the launch date", clientVisible: false });
    expect(await row(mP1)).toMatchObject({ status: "draft", drafted_by: null, updated_by: member, shared_at: null, shared_by: null });
  });

  it("a second save replaces the draft in place (one minutes row per meeting) and the body never reaches the outbox", async () => {
    const r = await put(member, mP1, "## Kickoff\n- agreed the launch date\n- owner: Sam");
    expect(r.statusCode).toBe(200);
    expect((r.json() as { minutes: { id: string } }).minutes.id).toBe(minutes.P1);
    const n = await adminPool().query(`SELECT count(*)::int AS n FROM meeting_minutes WHERE meeting_recording_id = $1`, [mP1]);
    expect(n.rows[0].n).toBe(1);
    const ev = await adminPool().query(`SELECT event_type, payload FROM outbox_events WHERE entity_type = 'meeting_minutes' AND entity_id = $1`, [minutes.P1]);
    expect(ev.rows.length).toBeGreaterThanOrEqual(2);
    for (const e of ev.rows) {
      expect(e.event_type).toBe("meeting.minutes.saved");
      expect(JSON.stringify(e.payload)).not.toContain("launch date");
    }
  });

  it("DRAFT => 404 on the portal: detail 404 and absent from the list, for an in-scope contact", async () => {
    expect(minutes.P1, "the draft's id was recorded by the save test").toMatch(/^[0-9a-f-]{36}$/);
    expect((await portalGet(wideA, minutes.P1)).statusCode).toBe(404);
    expect(await portalIds(wideA)).not.toContain(minutes.P1);
  });

  it("PV-D23: a bot may SAVE a draft (drafted_by is set to the bot), and a person who later edits it keeps that provenance", async () => {
    const r = await put(bot, mP2, "AI-drafted minutes for the P2 review");
    expect(r.statusCode).toBe(200);
    minutes.P2 = (r.json() as { minutes: { id: string } }).minutes.id;
    expect(await row(mP2)).toMatchObject({ status: "draft", drafted_by: bot, updated_by: bot });
    const edit = await put(member, mP2, "AI-drafted minutes for the P2 review, corrected by a person");
    expect(edit.statusCode).toBe(200);
    expect(await row(mP2)).toMatchObject({ status: "draft", drafted_by: bot, updated_by: member });
  });

  it("PV-D23: a bot CANNOT share (403 from Cerbos), and the minutes stay a draft", async () => {
    const r = await share(bot, mP2);
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: string }).error).toContain("cerbos denied share_minutes on meeting_recording");
    expect(await row(mP2)).toMatchObject({ status: "draft", shared_at: null, shared_by: null });
    expect((await portalGet(scopedP2, minutes.P2)).statusCode).toBe(404);
  });

  it("authorization runs BEFORE validation: a bot's share on a meeting with no minutes is a 403, not a 409; a viewer's save of garbage is a 403, not a 400", async () => {
    expect((await share(bot, mWide)).statusCode).toBe(403);
    expect((await put(staffViewer, mP1, 42)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: staff(mWide, "/share"), headers: asUser(wideA) })).statusCode).toBe(403);
  });

  it("validation: bodyMd must be a string (400 for an authorised caller); an unknown meeting is 404; a non-uuid id is 404", async () => {
    expect((await put(member, mP1, 42)).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: staff(mP1), headers: asUser(member), payload: {} })).statusCode).toBe(400);
    expect((await put(member, newId(), "x")).statusCode).toBe(404);
    expect((await put(member, "not-a-uuid", "x")).statusCode).toBe(404);
    expect((await share(member, newId())).statusCode).toBe(404);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Sharing: the preconditions
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("share with NO minutes saved yet is a 409", async () => {
    expect((await share(member, mWide)).statusCode).toBe(409);
    expect(await row(mWide)).toBeUndefined();
  });

  it("share with BLANK minutes is a 409 (whitespace is not minutes)", async () => {
    expect((await put(member, mWide, "  \n\t ")).statusCode).toBe(200);
    const r = await share(member, mWide);
    expect(r.statusCode).toBe(409);
    expect(await row(mWide)).toMatchObject({ status: "draft", shared_at: null });
  });

  it("share on a meeting with NO CLIENT is a 409, and nothing is stamped", async () => {
    expect((await put(member, mNoClient, "Internal-only retro notes")).statusCode).toBe(200);
    const r = await share(member, mNoClient);
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toContain("no client");
    expect(await row(mNoClient)).toMatchObject({ status: "draft", shared_at: null, shared_by: null });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Sharing: the happy path, its side effects, and double share
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a member who may update a meeting shares its minutes: ONE UPDATE stamps status, shared_at and shared_by", async () => {
    const r = await share(member, mP1);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: minutes.P1, meetingId: mP1, status: "shared", sharedBy: member });
    const m = await row(mP1);
    expect(m).toMatchObject({ status: "shared", shared_by: member });
    expect(m.shared_at).not.toBeNull();
  });

  it("sharing emits meeting.minutes.shared carrying the MEETING's clientId (the live-frame narrowing key) and no body", async () => {
    const ev = await adminPool().query(
      `SELECT payload FROM outbox_events WHERE entity_type = 'meeting_minutes' AND entity_id = $1 AND event_type = 'meeting.minutes.shared'`, [minutes.P1],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload).toMatchObject({ clientId: clientA, projectId: p1, meetingId: mP1, minutesId: minutes.P1, actorId: member });
    expect(JSON.stringify(ev.rows[0].payload)).not.toContain("launch date");
  });

  it("sharing notifies the contacts IN SCOPE (client-wide + this project's), deep-linking to /portal/meetings/<minutesId>; nobody else", async () => {
    const notified = async (user: string) =>
      (await adminPool().query(`SELECT payload FROM notifications WHERE user_id = $1 AND type = 'meeting.minutes.shared'`, [user])).rows;
    const wide = await notified(wideA);
    expect(wide).toHaveLength(1);
    expect(wide[0].payload).toMatchObject({ href: `/portal/meetings/${minutes.P1}`, entityType: "meeting_minutes", entityId: minutes.P1 });
    expect(wide[0].payload.title).toContain("Kickoff P1");
    expect(JSON.stringify(wide[0].payload)).not.toContain("launch date"); // the notice carries no minutes text
    expect(await notified(scopedP1)).toHaveLength(1);
    expect(await notified(scopedP2)).toHaveLength(0); // a contact of ANOTHER project
    expect(await notified(wideB)).toHaveLength(0);    // another client
    expect(await notified(revokedA)).toHaveLength(0); // revoked
  });

  it("DOUBLE SHARE => 409, and the share stamp does not move", async () => {
    const before = await row(mP1);
    const again = await share(admin, mP1);
    expect(again.statusCode).toBe(409);
    expect(await row(mP1)).toMatchObject({ shared_by: member, shared_at: before.shared_at });
    const n = await adminPool().query(`SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'meeting.minutes.shared'`, [minutes.P1]);
    expect(n.rows[0].n).toBe(1);
  });

  it("CONCURRENT shares: exactly one wins, the other is a 409 (the guarded UPDATE)", async () => {
    expect((await put(member, mMove, "Minutes of the meeting that will move")).statusCode).toBe(200);
    minutes.Move = (await row(mMove)).id;
    const results = await Promise.all([share(member, mMove), share(admin, mMove), share(member, mMove)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const n = await adminPool().query(`SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'meeting.minutes.shared'`, [minutes.Move]);
    expect(n.rows[0].n).toBe(1);
  });

  it("once shared, the minutes are FROZEN: a save is a 409 and the text a client read does not change", async () => {
    const r = await put(member, mP1, "REWRITTEN after the client read it");
    expect(r.statusCode).toBe(409);
    expect((await row(mP1)).body_md).toBe("## Kickoff\n- agreed the launch date\n- owner: Sam");
  });

  it("there is no unshare route: DELETE and PATCH on the minutes are not routes", async () => {
    for (const method of ["DELETE", "PATCH"] as const) {
      const r = await app.inject({ method, url: staff(mP1), headers: asUser(admin) });
      expect([404, 405], `${method} → ${r.statusCode}`).toContain(r.statusCode);
    }
    const r = await app.inject({ method: "POST", url: staff(mP1, "/unshare"), headers: asUser(admin) });
    expect(r.statusCode).toBe(404);
    expect((await row(mP1)).status).toBe("shared");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // The portal: scope, 404s, and the pinned payload
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("SHARED => 200 for an in-scope contact, and the payload is EXACTLY title, date, body, sharedAt and the sharer's name", async () => {
    const r = await portalGet(wideA, minutes.P1);
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(PORTAL_KEYS);
    expect(body).toMatchObject({
      id: minutes.P1, title: "Kickoff P1", bodyMd: "## Kickoff\n- agreed the launch date\n- owner: Sam", sharedBy: "Mia Member",
    });
    expect(new Date(body.meetingDate as string).toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(typeof body.sharedAt).toBe("string");
    for (const marker of MARKERS) expect(r.body, `the portal detail must not carry ${marker}`).not.toContain(marker);
  });

  it("the LIST carries the same pinned shape, and no transcript, audio, Drive link, participant or pipeline field", async () => {
    const r = await app.inject({ method: "GET", url: portal(), headers: asUser(wideA) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const m of rows) expect(Object.keys(m).sort()).toEqual(PORTAL_KEYS);
    for (const marker of MARKERS) expect(r.body, `the portal list must not carry ${marker}`).not.toContain(marker);
    for (const field of ["transcript", "transcript_ref", "transcriptRef", "audio_ref", "audioRef", "local_hint", "localHint", "driveLink", "drive_link", "participants", "pipelineRunId", "clientId", "projectId"]) {
      expect(r.body, field).not.toContain(`"${field}"`);
    }
  });

  it("ANOTHER CLIENT's contact gets 404 on the shared minutes (and the id is absent from their list)", async () => {
    expect((await portalGet(wideB, minutes.P1)).statusCode).toBe(404);
    expect(await portalIds(wideB)).not.toContain(minutes.P1);
  });

  it("404 is the answer for 'does not exist' and 'not yours' alike (no existence oracle), and for a non-uuid id", async () => {
    const unknown = await portalGet(wideB, newId());
    const notYours = await portalGet(wideB, minutes.P1);
    expect(unknown.statusCode).toBe(404);
    expect(notYours.statusCode).toBe(404);
    expect(unknown.json()).toEqual(notYours.json()); // byte-identical bodies
    expect((await portalGet(wideA, "not-a-uuid")).statusCode).toBe(404);
  });

  it("a P1-scoped contact sees P1's shared minutes; P2's shared minutes are a 404 to them and a 200 to a P2-scoped contact", async () => {
    // A person finishes the bot's draft and shares it (the bot may never).
    const s = await share(member, mP2);
    expect(s.statusCode).toBe(200);
    expect(await row(mP2)).toMatchObject({ status: "shared", drafted_by: bot, shared_by: member });

    expect((await portalGet(scopedP1, minutes.P1)).statusCode).toBe(200);
    expect((await portalGet(scopedP1, minutes.P2)).statusCode).toBe(404);
    expect((await portalGet(scopedP2, minutes.P2)).statusCode).toBe(200);
    expect((await portalGet(scopedP2, minutes.P1)).statusCode).toBe(404);

    const p1List = await portalIds(scopedP1);
    expect(p1List).toContain(minutes.P1);
    expect(p1List).not.toContain(minutes.P2);
    // The client-wide contact sees both projects' minutes.
    expect(await portalIds(wideA)).toEqual(expect.arrayContaining([minutes.P1, minutes.P2]));
  });

  it("PV4-Q1: the minutes of a meeting with NO PROJECT are visible to a client-wide contact ONLY, never to a project-scoped one", async () => {
    expect((await put(member, mWide, "Client-wide quarterly minutes")).statusCode).toBe(200);
    minutes.Wide = (await row(mWide)).id;
    expect((await share(member, mWide)).statusCode).toBe(200);

    expect((await portalGet(wideA, minutes.Wide)).statusCode).toBe(200);
    expect((await portalGet(scopedP1, minutes.Wide)).statusCode).toBe(404);
    expect((await portalGet(scopedP2, minutes.Wide)).statusCode).toBe(404);
    expect(await portalIds(scopedP1)).not.toContain(minutes.Wide);
    expect(await portalIds(wideA)).toContain(minutes.Wide);
    // ... and a project-less meeting's share notified the client-wide contact only.
    const n = (uid: string) => adminPool().query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'meeting.minutes.shared' AND payload->>'entityId' = $2`, [uid, minutes.Wide]);
    expect((await n(wideA)).rowCount).toBe(1);
    expect((await n(scopedP1)).rowCount).toBe(0);
    expect((await n(scopedP2)).rowCount).toBe(0);
  });

  it("?projectId= narrows the list; a malformed projectId is a 400; another client's project id yields nothing", async () => {
    // (mMove is also a shared P1 meeting at this point; it is re-linked away in a later test.)
    const onP1 = await portalIds(wideA, `?projectId=${p1}`);
    expect(onP1).toEqual(expect.arrayContaining([minutes.P1, minutes.Move]));
    expect(onP1).not.toContain(minutes.P2);
    expect(onP1).not.toContain(minutes.Wide);
    expect(await portalIds(wideA, `?projectId=${p2}`)).toEqual([minutes.P2]);
    expect(await portalIds(wideA, `?projectId=${pB}`)).toEqual([]);
    expect((await app.inject({ method: "GET", url: portal("?projectId=zzz"), headers: asUser(wideA) })).statusCode).toBe(400);
  });

  it("a revoked contact is refused by the scope kernel; a staff caller has no portal door", async () => {
    expect((await portalGet(revokedA, minutes.P1)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: portal(), headers: asUser(revokedA) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: portal(), headers: asUser(member) })).statusCode).toBe(403);
  });

  it("the client's own tenant wall: B's shared minutes never appear for A and vice versa", async () => {
    expect((await put(member, mB, "B's minutes")).statusCode).toBe(200);
    minutes.B = (await row(mB)).id;
    expect((await share(member, mB)).statusCode).toBe(200);
    expect(await portalIds(wideB)).toEqual([minutes.B]);
    expect(await portalIds(wideA)).not.toContain(minutes.B);
    expect((await portalGet(wideA, minutes.B)).statusCode).toBe(404);
  });

  it("DECISION 8 (no copy): re-linking the meeting to another client moves its shared minutes with it", async () => {
    expect((await portalGet(wideA, minutes.Move)).statusCode).toBe(200);
    await adminPool().query(`UPDATE meeting_recordings SET client_id = $2, project_id = NULL WHERE id = $1`, [mMove, clientB]);
    expect((await portalGet(wideA, minutes.Move)).statusCode).toBe(404);
    expect((await portalGet(wideB, minutes.Move)).statusCode).toBe(200);
    // ... and a meeting that LOSES its client takes its minutes out of every portal.
    await adminPool().query(`UPDATE meeting_recordings SET client_id = NULL WHERE id = $1`, [mMove]);
    expect((await portalGet(wideB, minutes.Move)).statusCode).toBe(404);
  });

  it("a soft-deleted meeting takes its shared minutes with it", async () => {
    expect((await put(member, mDel, "Minutes of a meeting that gets deleted")).statusCode).toBe(200);
    minutes.Del = (await row(mDel)).id;
    expect((await share(member, mDel)).statusCode).toBe(200);
    expect((await portalGet(wideA, minutes.Del)).statusCode).toBe(200);
    await adminPool().query(`UPDATE meeting_recordings SET deleted_at = now() WHERE id = $1`, [mDel]);
    expect((await portalGet(wideA, minutes.Del)).statusCode).toBe(404);
    expect(await portalIds(wideA)).not.toContain(minutes.Del);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Staff reads and the `clientVisible` marker
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("staff GET: a viewer may read; the marker agrees with the portal (shared+client => true, draft or no client => false); no minutes => null", async () => {
    const shared = await app.inject({ method: "GET", url: staff(mP1), headers: asUser(staffViewer) });
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toMatchObject({
      meetingId: mP1, clientId: clientA, projectId: p1, shareable: false,
      minutes: { id: minutes.P1, status: "shared", clientVisible: true, sharedBy: member, sharedByName: "Mia Member" },
    });
    const draft = await app.inject({ method: "GET", url: staff(mNoClient), headers: asUser(admin) });
    expect(draft.json()).toMatchObject({ clientId: null, shareable: false, minutes: { status: "draft", clientVisible: false } });
    const none = await seedMeeting("Not yet minuted", clientA, p1);
    const empty = await app.inject({ method: "GET", url: staff(none), headers: asUser(admin) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ meetingId: none, shareable: false, minutes: null });
    expect((await app.inject({ method: "GET", url: staff(newId()), headers: asUser(admin) })).statusCode).toBe(404);
  });

  it("staff routes: a client contact is refused by Cerbos on every one (the client role is not on meeting_recording)", async () => {
    expect((await app.inject({ method: "GET", url: staff(mP1), headers: asUser(wideA) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: staff(mP1), headers: asUser(wideA), payload: { bodyMd: "x" } })).statusCode).toBe(403);
    expect((await share(wideA, mP1)).statusCode).toBe(403);
  });

  it("`meeting` itself stays internal: the staff meeting list still marks every recording clientVisible=false, and the portal has no meetings/recordings route", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/meetings/recordings`, headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    for (const m of list.json() as Array<{ clientVisible: boolean }>) expect(m.clientVisible).toBe(false);
    // `recordings` is not a minutes id: it is a 404 (not a uuid), never a recording.
    expect((await portalGet(wideA, "recordings")).statusCode).toBe(404);
  });
});
