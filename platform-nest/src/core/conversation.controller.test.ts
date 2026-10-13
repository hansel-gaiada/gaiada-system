// PV4-03 — client Conversation over HTTP, against real Postgres (RLS) + Cerbos. Both surfaces:
//   * the PORTAL (`portal` read / converse; isolation through portal-scope.ts + conversationThreadInPortalScope)
//   * the STAFF side (Cerbos kind `conversation`: read / post / draft / manage; PV-D23 agent DENY)
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-03). BFF: docs/FRONTEND-BFF-CONTRACT.md §29.
//
// This is the client-isolation ticket, so the isolation assertions are BY ID: a list that "looks right"
// proves nothing; a list that does not contain another client's thread id does. Every write claim is
// checked against the stored row through adminPool (bypassing RLS), not inferred from a 2xx.
//
// Needs DATABASE_URL_TEST + a Cerbos loaded with the current policies (resource_conversation.yaml,
// resource_portal.yaml's `converse`). Runs on the Linux gate; skipped elsewhere — and a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { setStorageForTest, localStorage as diskStorage, type StorageBackend } from "./storage";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const memStore = new Map<string, Buffer>();
const memoryStorage: StorageBackend = {
  async put(k, d) { memStore.set(k, Buffer.from(d)); },
  async get(k) {
    const v = memStore.get(k);
    if (!v) throw new Error("missing");
    return v;
  },
  async del(k) { memStore.delete(k); },
};

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

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

interface ThreadListRow { id: string; unreadCount: number; awaitingReply?: boolean; general: boolean; clientVisible?: boolean }
interface MessageRow {
  id: string; body: string; authorId: string; authorSide: string;
  attachments: Array<{ id: string }>; clientVisible?: boolean; draftedBy?: string | null; mine: boolean;
}

describe.skipIf(!TEST_URL)("PV4-03: client Conversation API (portal + staff)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let clientB: string;
  let p1: string;   // clientA
  let p2: string;   // clientA
  let pB: string;   // clientB

  // client side
  let wideA: string;     // client-wide contact of A, capability VIEWER (PV-D24: viewers post)
  let wideA2: string;    // a second client-wide contact of A (a colleague)
  let scopedP1: string;  // contact of A scoped to P1 only, signer
  let wideB: string;     // client-wide contact of B
  let wideB2: string;    // second contact of B (for the lazy general-thread race)
  let revokedA: string;  // revoked contact of A

  // staff side
  let admin: string;     // company_admin
  let member: string;    // member
  let staffViewer: string; // viewer role: read only
  let bot: string;       // member role, users.kind = 'bot'

  // ids built up across the suite
  let generalA: string;  // A's client-wide thread
  let threadP1: string;  // a thread on P1 opened by scopedP1
  let threadP2: string;  // a thread on P2 opened by staff

  const portal = (tenant: string) => `/api/${tenant}/portal/conversation`;
  const staff = (tenant: string) => `/api/${tenant}/conversation`;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    setStorageForTest(memoryStorage);

    co = await createCompany("PV4 Agency");
    const clientRole = await createRole("client");
    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    const viewerRole = await createRole("viewer");

    clientA = await createClient(co, "PV4 Client A");
    clientB = await createClient(co, "PV4 Client B");
    p1 = await createProject(co, "PV4 A Project 1");
    p2 = await createProject(co, "PV4 A Project 2");
    pB = await createProject(co, "PV4 B Project");
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = ANY($2::uuid[])`, [clientA, [p1, p2]]);
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientB, pB]);

    const contact = async (email: string, client: string, opts: Parameters<typeof addContact>[3] = {}) => {
      const u = await createUser(email);
      await addContact(co, client, u, opts);
      await grantRole(u, clientRole, "company", co);
      return u;
    };
    wideA = await contact("wide-a@client.test", clientA, { capability: "viewer" });
    wideA2 = await contact("wide-a2@client.test", clientA, { capability: "signer" });
    scopedP1 = await contact("scoped-p1@client.test", clientA, { capability: "signer", projectId: p1 });
    wideB = await contact("wide-b@client.test", clientB, { capability: "viewer" });
    wideB2 = await contact("wide-b2@client.test", clientB, { capability: "viewer" });
    revokedA = await contact("revoked-a@client.test", clientA, { status: "revoked" });

    const staffUser = async (email: string, role: string) => {
      const u = await createUser(email);
      await addMembership(co, u);
      await grantRole(u, role, "company", co);
      return u;
    };
    admin = await staffUser("admin@agency.test", adminRole);
    member = await staffUser("member@agency.test", memberRole);
    staffViewer = await staffUser("viewer@agency.test", viewerRole);
    bot = await staffUser("bot@agency.test", memberRole);
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);

    app = await buildApp();
  });

  afterAll(async () => {
    setStorageForTest(diskStorage);
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Portal: opening, the lazy general thread, spoofing, PV-D24
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a VIEWER contact opens the general thread (PV-D24) and every body-supplied identity field is ignored", async () => {
    const r = await app.inject({
      method: "POST", url: portal(co), headers: asUser(wideA),
      payload: {
        body: "Hello from client A",
        // Spoof attempts: none of these may reach a column.
        authorId: admin, author_id: admin, authorSide: "staff", author_side: "staff",
        clientId: clientB, client_id: clientB, tenantId: newId(), status: "closed",
      },
    });
    expect(r.statusCode).toBe(201);
    const out = r.json() as { threadId: string; messageId: string; created: boolean };
    expect(out.created).toBe(true);
    generalA = out.threadId;

    const t = await adminPool().query(`SELECT tenant_id, client_id, project_id, status, created_by, created_side FROM conversation_threads WHERE id = $1`, [generalA]);
    expect(t.rows[0]).toMatchObject({ tenant_id: co, client_id: clientA, project_id: null, status: "open", created_by: wideA, created_side: "client" });
    const m = await adminPool().query(`SELECT author_id, author_side, body, drafted_by FROM conversation_messages WHERE id = $1`, [out.messageId]);
    expect(m.rows[0]).toMatchObject({ author_id: wideA, author_side: "client", body: "Hello from client A", drafted_by: null });

    // The outbox row committed with the write and carries the thread's clientId (the live-bus narrowing key).
    const ev = await adminPool().query(
      `SELECT event_type, payload FROM outbox_events WHERE entity_type = 'conversation' AND entity_id = ANY($1::uuid[]) ORDER BY event_type`,
      [[generalA, out.messageId]],
    );
    expect(ev.rows.map((e) => e.event_type)).toEqual(["conversation.message.posted", "conversation.thread.opened"]);
    for (const e of ev.rows) expect(e.payload.clientId).toBe(clientA);
  });

  it("a second post without a project lands in the SAME general thread (no second client-wide thread)", async () => {
    const r = await app.inject({ method: "POST", url: portal(co), headers: asUser(wideA2), payload: { body: "Colleague here" } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ threadId: generalA, created: false });
  });

  it("the lazy general thread is race-safe: concurrent first posts all succeed into ONE thread", async () => {
    const posts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.inject({ method: "POST", url: portal(co), headers: asUser(i % 2 ? wideB2 : wideB), payload: { body: `race ${i}` } }),
      ),
    );
    expect(posts.map((p) => p.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);
    const ids = new Set(posts.map((p) => (p.json() as { threadId: string }).threadId));
    expect(ids.size).toBe(1);
    expect(posts.filter((p) => (p.json() as { created: boolean }).created)).toHaveLength(1);
    const n = await adminPool().query(
      `SELECT count(*)::int AS n FROM conversation_threads WHERE client_id = $1 AND project_id IS NULL AND deleted_at IS NULL`, [clientB],
    );
    expect(n.rows[0].n).toBe(1);
    const msgs = await adminPool().query(`SELECT count(*)::int AS n FROM conversation_messages WHERE thread_id = $1`, [[...ids][0]]);
    expect(msgs.rows[0].n).toBe(6);
  });

  it("a project-scoped contact opens a thread on THEIR project; another project and the general thread are 404", async () => {
    const ok = await app.inject({ method: "POST", url: portal(co), headers: asUser(scopedP1), payload: { projectId: p1, subject: "Homepage", body: "About P1" } });
    expect(ok.statusCode).toBe(201);
    threadP1 = (ok.json() as { threadId: string }).threadId;
    const t = await adminPool().query(`SELECT client_id, project_id, subject FROM conversation_threads WHERE id = $1`, [threadP1]);
    expect(t.rows[0]).toMatchObject({ client_id: clientA, project_id: p1, subject: "Homepage" });

    const otherProject = await app.inject({ method: "POST", url: portal(co), headers: asUser(scopedP1), payload: { projectId: p2, body: "x" } });
    expect(otherProject.statusCode).toBe(404);
    const general = await app.inject({ method: "POST", url: portal(co), headers: asUser(scopedP1), payload: { body: "x" } });
    expect(general.statusCode).toBe(404);
    // Another client's project is not found either (never "forbidden").
    const foreign = await app.inject({ method: "POST", url: portal(co), headers: asUser(wideA), payload: { projectId: pB, body: "x" } });
    expect(foreign.statusCode).toBe(404);
  });

  it("staff open a thread on P2 for client A", async () => {
    const r = await app.inject({ method: "POST", url: staff(co), headers: asUser(member), payload: { clientId: clientA, projectId: p2, body: "P2 kickoff" } });
    expect(r.statusCode).toBe(201);
    threadP2 = (r.json() as { threadId: string }).threadId;
    const m = await adminPool().query(`SELECT author_id, author_side FROM conversation_messages WHERE thread_id = $1`, [threadP2]);
    expect(m.rows[0]).toMatchObject({ author_id: member, author_side: "staff" });
    // A project of another client is refused.
    const wrong = await app.inject({ method: "POST", url: staff(co), headers: asUser(member), payload: { clientId: clientA, projectId: pB, body: "x" } });
    expect(wrong.statusCode).toBe(400);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Portal isolation — by id
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a P1-scoped contact: the list holds P1's thread only; P2's thread and the client-wide thread are 404", async () => {
    const list = await app.inject({ method: "GET", url: portal(co), headers: asUser(scopedP1) });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { threads: ThreadListRow[]; canUseGeneral: boolean };
    const ids = body.threads.map((t) => t.id);
    expect(ids).toContain(threadP1);
    expect(ids).not.toContain(threadP2);
    expect(ids).not.toContain(generalA);
    expect(body.canUseGeneral).toBe(false);

    for (const tid of [threadP2, generalA]) {
      const g = await app.inject({ method: "GET", url: `${portal(co)}/${tid}`, headers: asUser(scopedP1) });
      expect(g.statusCode).toBe(404);
      const post = await app.inject({ method: "POST", url: `${portal(co)}/${tid}/messages`, headers: asUser(scopedP1), payload: { body: "x" } });
      expect(post.statusCode).toBe(404);
    }
    const own = await app.inject({ method: "GET", url: `${portal(co)}/${threadP1}`, headers: asUser(scopedP1) });
    expect(own.statusCode).toBe(200);
  });

  it("a client-wide contact of A sees all of A's threads; ?projectId narrows", async () => {
    const list = await app.inject({ method: "GET", url: portal(co), headers: asUser(wideA) });
    const ids = (list.json() as { threads: ThreadListRow[] }).threads.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([generalA, threadP1, threadP2]));
    const narrowed = await app.inject({ method: "GET", url: `${portal(co)}?projectId=${p2}`, headers: asUser(wideA) });
    expect((narrowed.json() as { threads: ThreadListRow[] }).threads.map((t) => t.id)).toEqual([threadP2]);
  });

  it("a contact of client B gets 404 on every client-A thread and message, and never lists one", async () => {
    const list = await app.inject({ method: "GET", url: portal(co), headers: asUser(wideB) });
    const ids = (list.json() as { threads: ThreadListRow[] }).threads.map((t) => t.id);
    for (const tid of [generalA, threadP1, threadP2]) {
      expect(ids).not.toContain(tid);
      expect((await app.inject({ method: "GET", url: `${portal(co)}/${tid}`, headers: asUser(wideB) })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `${portal(co)}/${tid}/messages`, headers: asUser(wideB), payload: { body: "x" } })).statusCode).toBe(404);
    }
    const aMsg = await adminPool().query(`SELECT id FROM conversation_messages WHERE thread_id = $1 AND author_id = $2 LIMIT 1`, [generalA, wideA]);
    const msgId = aMsg.rows[0].id as string;
    // PV-D34: there is no edit/retract route at all, so another client's contact gets the same 404 as anyone.
    expect((await app.inject({ method: "PATCH", url: `${portal(co)}/messages/${msgId}`, headers: asUser(wideB), payload: { body: "hijack" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${portal(co)}/messages/${msgId}`, headers: asUser(wideB) })).statusCode).toBe(404);
    // Nothing changed.
    const after = await adminPool().query(`SELECT body, edited_at, retracted_at FROM conversation_messages WHERE id = $1`, [msgId]);
    expect(after.rows[0]).toMatchObject({ body: "Hello from client A", edited_at: null, retracted_at: null });
  });

  it("a revoked contact is refused by the scope kernel", async () => {
    const r = await app.inject({ method: "GET", url: portal(co), headers: asUser(revokedA) });
    expect(r.statusCode).toBe(403);
    const post = await app.inject({ method: "POST", url: portal(co), headers: asUser(revokedA), payload: { body: "x" } });
    expect(post.statusCode).toBe(403);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Attachments: inline upload, both download routes, isolation
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  let attGeneral: string; // on A's general thread (client-wide only)
  let attP1: string;      // on the P1 thread
  let attMsg: string;

  it("a reply carries inline attachments; the caller downloads them through the portal route", async () => {
    const r = await app.inject({
      method: "POST", url: `${portal(co)}/${generalA}/messages`, headers: asUser(wideA),
      payload: { body: "See attached", attachments: [{ filename: "notes.txt", contentType: "text/plain", content: b64("brief v2") }] },
    });
    expect(r.statusCode).toBe(201);
    const out = r.json() as { id: string; attachmentIds: string[] };
    expect(out.attachmentIds).toHaveLength(1);
    attGeneral = out.attachmentIds[0];
    attMsg = out.id;
    const f = await adminPool().query(`SELECT target_entity_type, target_entity_id, uploader_id FROM files WHERE id = $1`, [attGeneral]);
    expect(f.rows[0]).toMatchObject({ target_entity_type: "conversation", target_entity_id: attMsg, uploader_id: wideA });

    const dl = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${attGeneral}`, headers: asUser(wideA) });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe("brief v2");
    expect(dl.headers["content-disposition"]).toContain("attachment");

    const p1r = await app.inject({
      method: "POST", url: `${portal(co)}/${threadP1}/messages`, headers: asUser(scopedP1),
      payload: { body: "P1 file", attachments: [{ filename: "p1.txt", contentType: "text/plain", content: b64("p1 bytes") }] },
    });
    expect(p1r.statusCode).toBe(201);
    attP1 = (p1r.json() as { attachmentIds: string[] }).attachmentIds[0];
    expect((await app.inject({ method: "GET", url: `/api/${co}/portal/files/${attP1}`, headers: asUser(scopedP1) })).statusCode).toBe(200);
  });

  it("attachment isolation: another client's contact and a P1-scoped contact cannot download a client-wide thread's file", async () => {
    expect((await app.inject({ method: "GET", url: `/api/${co}/portal/files/${attGeneral}`, headers: asUser(wideB) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/${co}/portal/files/${attGeneral}`, headers: asUser(scopedP1) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/${co}/portal/files/${attP1}`, headers: asUser(wideB) })).statusCode).toBe(404);
    // Staff read it through the staff content route, which authorizes the `conversation` kind.
    const s = await app.inject({ method: "GET", url: `/api/${co}/files/${attGeneral}/content`, headers: asUser(member) });
    expect(s.statusCode).toBe(200);
  });

  it("attachment limits: more than 5 files is a 400 (after authorization)", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.txt`, contentType: "text/plain", content: b64("x") }));
    const r = await app.inject({ method: "POST", url: `${portal(co)}/${generalA}/messages`, headers: asUser(wideA), payload: { body: "too many", attachments: six } });
    expect(r.statusCode).toBe(400);
    // Authorization runs first: a staff user (no `client` role) is refused `portal converse` with 403, not a 400.
    const denied = await app.inject({ method: "POST", url: `${portal(co)}/${generalA}/messages`, headers: asUser(member), payload: { body: "", attachments: six } });
    expect(denied.statusCode).toBe(403);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // PV-D34: messages are permanent. The edit/retract routes are GONE (404, not 403), on both surfaces.
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  const unchanged = async (id: string, body: string) => {
    const row = await adminPool().query(`SELECT body, edited_at, retracted_at FROM conversation_messages WHERE id = $1`, [id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ body, edited_at: null, retracted_at: null });
  };

  it("PORTAL: PATCH and DELETE on a message answer 404 for its author, a colleague and for staff's message, and nothing changes", async () => {
    const mine = await adminPool().query(`SELECT id FROM conversation_messages WHERE thread_id = $1 AND author_id = $2 AND body = 'Colleague here'`, [generalA, wideA2]);
    const id = mine.rows[0].id as string;
    for (const who of [wideA2, wideA]) {
      expect((await app.inject({ method: "PATCH", url: `${portal(co)}/messages/${id}`, headers: asUser(who), payload: { body: "edited" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `${portal(co)}/messages/${id}`, headers: asUser(who) })).statusCode).toBe(404);
    }
    await unchanged(id, "Colleague here");
    const staffMsg = await adminPool().query(`SELECT id, body FROM conversation_messages WHERE thread_id = $1 AND author_side = 'staff' LIMIT 1`, [threadP2]);
    const sid = staffMsg.rows[0].id as string;
    expect((await app.inject({ method: "PATCH", url: `${portal(co)}/messages/${sid}`, headers: asUser(wideA), payload: { body: "nope" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${portal(co)}/messages/${sid}`, headers: asUser(wideA) })).statusCode).toBe(404);
    await unchanged(sid, staffMsg.rows[0].body as string);
  });

  it("PORTAL: an attachment-bearing message stays whole: body, attachment and download survive a DELETE attempt", async () => {
    expect((await app.inject({ method: "DELETE", url: `${portal(co)}/messages/${attMsg}`, headers: asUser(wideA) })).statusCode).toBe(404);
    const pd = await app.inject({ method: "GET", url: `${portal(co)}/${generalA}`, headers: asUser(wideA) });
    const pm = (pd.json() as { messages: MessageRow[] }).messages.find((m) => m.id === attMsg) as MessageRow;
    expect(pm).toMatchObject({ body: "See attached" });
    expect(pm.attachments).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/api/${co}/portal/files/${attGeneral}`, headers: asUser(wideA) })).statusCode).toBe(200);
  });

  it("STAFF: PATCH and DELETE on a message answer 404 for the author, a colleague and for a client's message, and nothing changes", async () => {
    const r = await app.inject({ method: "POST", url: `${staff(co)}/${generalA}/messages`, headers: asUser(admin), payload: { body: "admin words" } });
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    for (const who of [admin, member]) {
      expect((await app.inject({ method: "PATCH", url: `${staff(co)}/messages/${id}`, headers: asUser(who), payload: { body: "admin words, fixed" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `${staff(co)}/messages/${id}`, headers: asUser(who) })).statusCode).toBe(404);
    }
    await unchanged(id, "admin words");
    const clientMsg = await adminPool().query(`SELECT id, body FROM conversation_messages WHERE author_side = 'client' LIMIT 1`);
    const cid = clientMsg.rows[0].id as string;
    expect((await app.inject({ method: "PATCH", url: `${staff(co)}/messages/${cid}`, headers: asUser(admin), payload: { body: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${staff(co)}/messages/${cid}`, headers: asUser(admin) })).statusCode).toBe(404);
    await unchanged(cid, clientMsg.rows[0].body as string);
  });

  it("the message payload on BOTH surfaces carries no edit/retract fields (PV-D34)", async () => {
    const pd = await app.inject({ method: "GET", url: `${portal(co)}/${generalA}`, headers: asUser(wideA) });
    const sd = await app.inject({ method: "GET", url: `${staff(co)}/${generalA}`, headers: asUser(member) });
    for (const res of [pd, sd]) {
      expect(res.statusCode).toBe(200);
      const messages = (res.json() as { messages: Array<Record<string, unknown>> }).messages;
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) {
        for (const k of ["edited", "editedAt", "retracted", "editableUntil"]) expect(m).not.toHaveProperty(k);
        expect(typeof m.body).toBe("string");
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Unread counts and read markers
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("unread = messages from the OTHER side newer than the caller's marker; viewing marks read (both sides)", async () => {
    // wideA reads the thread first, so only what follows is new.
    await app.inject({ method: "GET", url: `${portal(co)}/${threadP2}`, headers: asUser(wideA) });
    const before = await app.inject({ method: "GET", url: portal(co), headers: asUser(wideA) });
    expect((before.json() as { threads: ThreadListRow[] }).threads.find((t) => t.id === threadP2)?.unreadCount).toBe(0);

    await app.inject({ method: "POST", url: `${staff(co)}/${threadP2}/messages`, headers: asUser(admin), payload: { body: "staff 1" } });
    await app.inject({ method: "POST", url: `${staff(co)}/${threadP2}/messages`, headers: asUser(admin), payload: { body: "staff 2" } });
    // A colleague on the client side does not count as unread for wideA.
    await app.inject({ method: "POST", url: `${portal(co)}/${threadP2}/messages`, headers: asUser(wideA2), payload: { body: "client colleague" } });

    const after = await app.inject({ method: "GET", url: portal(co), headers: asUser(wideA) });
    expect((after.json() as { threads: ThreadListRow[] }).threads.find((t) => t.id === threadP2)?.unreadCount).toBe(2);
    await app.inject({ method: "GET", url: `${portal(co)}/${threadP2}`, headers: asUser(wideA) });
    const read = await app.inject({ method: "GET", url: portal(co), headers: asUser(wideA) });
    expect((read.json() as { threads: ThreadListRow[] }).threads.find((t) => t.id === threadP2)?.unreadCount).toBe(0);

    // Staff: member has not read since the client colleague posted; awaitingReply is the client's last word.
    const s1 = await app.inject({ method: "GET", url: `${staff(co)}?clientId=${clientA}`, headers: asUser(member) });
    const row = (s1.json() as { threads: ThreadListRow[] }).threads.find((t) => t.id === threadP2) as ThreadListRow;
    expect(row.unreadCount).toBeGreaterThanOrEqual(1);
    expect(row.awaitingReply).toBe(true);
    const awaiting = await app.inject({ method: "GET", url: `${staff(co)}?awaitingReply=true`, headers: asUser(member) });
    expect((awaiting.json() as { threads: ThreadListRow[] }).threads.map((t) => t.id)).toContain(threadP2);
    await app.inject({ method: "GET", url: `${staff(co)}/${threadP2}`, headers: asUser(member) });
    const s2 = await app.inject({ method: "GET", url: `${staff(co)}?clientId=${clientA}`, headers: asUser(member) });
    expect((s2.json() as { threads: ThreadListRow[] }).threads.find((t) => t.id === threadP2)?.unreadCount).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Staff: authz, PV-D23 drafts, clientVisible, close/reopen
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a staff viewer reads but cannot post; a client principal reaches no staff route", async () => {
    expect((await app.inject({ method: "GET", url: staff(co), headers: asUser(staffViewer) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${staff(co)}/${generalA}/messages`, headers: asUser(staffViewer), payload: { body: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: staff(co), headers: asUser(wideA) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${staff(co)}/${generalA}/drafts`, headers: asUser(wideA) })).statusCode).toBe(403);
  });

  it("every staff message and thread row carries clientVisible: true from the backend", async () => {
    const d = await app.inject({ method: "GET", url: `${staff(co)}/${generalA}`, headers: asUser(member) });
    const body = d.json() as { thread: { clientVisible: boolean }; messages: MessageRow[] };
    expect(body.thread.clientVisible).toBe(true);
    expect(body.messages.length).toBeGreaterThan(0);
    for (const m of body.messages) expect(m.clientVisible).toBe(true);
    const list = await app.inject({ method: "GET", url: staff(co), headers: asUser(member) });
    for (const t of (list.json() as { threads: ThreadListRow[] }).threads) expect(t.clientVisible).toBe(true);
  });

  it("PV-D23: a bot may draft but is refused post and draft-send by Cerbos; a human sends it as themselves", async () => {
    const botPost = await app.inject({ method: "POST", url: `${staff(co)}/${generalA}/messages`, headers: asUser(bot), payload: { body: "agent speaking" } });
    expect(botPost.statusCode).toBe(403);
    expect((botPost.json() as { error: string }).error).toContain("cerbos denied post on conversation");

    const draft = await app.inject({
      method: "POST", url: `${staff(co)}/${generalA}/drafts`, headers: asUser(bot),
      payload: { body: "SECRET-DRAFT-TEXT proposed reply", idempotencyKey: "pv4-03-k1", authorId: admin },
    });
    expect(draft.statusCode).toBe(201);
    const d = draft.json() as { id: string; clientVisible: boolean; replayed: boolean };
    expect(d).toMatchObject({ clientVisible: false, replayed: false });
    const replay = await app.inject({ method: "POST", url: `${staff(co)}/${generalA}/drafts`, headers: asUser(bot), payload: { body: "again", idempotencyKey: "pv4-03-k1" } });
    expect(replay.json()).toMatchObject({ id: d.id, replayed: true });
    const dr = await adminPool().query(`SELECT drafted_by, status FROM conversation_drafts WHERE id = $1`, [d.id]);
    expect(dr.rows[0]).toMatchObject({ drafted_by: bot, status: "pending" });

    // Drafts never reach the portal (no portal route reads the table), and staff see clientVisible: false.
    const pd = await app.inject({ method: "GET", url: `${portal(co)}/${generalA}`, headers: asUser(wideA) });
    expect(pd.body).not.toContain("SECRET-DRAFT-TEXT");
    const list = await app.inject({ method: "GET", url: `${staff(co)}/${generalA}/drafts`, headers: asUser(member) });
    const drafts = (list.json() as { drafts: Array<{ id: string; clientVisible: boolean }> }).drafts;
    expect(drafts.find((x) => x.id === d.id)?.clientVisible).toBe(false);

    const botSend = await app.inject({ method: "POST", url: `${staff(co)}/drafts/${d.id}/send`, headers: asUser(bot) });
    expect(botSend.statusCode).toBe(403);
    expect((botSend.json() as { error: string }).error).toContain("cerbos denied post on conversation");

    const send = await app.inject({ method: "POST", url: `${staff(co)}/drafts/${d.id}/send`, headers: asUser(member) });
    expect(send.statusCode).toBe(201);
    const sent = send.json() as { id: string };
    const msg = await adminPool().query(`SELECT author_id, author_side, drafted_by, body FROM conversation_messages WHERE id = $1`, [sent.id]);
    expect(msg.rows[0]).toMatchObject({ author_id: member, author_side: "staff", drafted_by: bot, body: "SECRET-DRAFT-TEXT proposed reply" });
    const after = await adminPool().query(`SELECT status, sent_message_id, decided_by, decided_at FROM conversation_drafts WHERE id = $1`, [d.id]);
    expect(after.rows[0]).toMatchObject({ status: "sent", sent_message_id: sent.id, decided_by: member });
    expect(after.rows[0].decided_at).not.toBeNull();

    // Sent once only.
    expect((await app.inject({ method: "POST", url: `${staff(co)}/drafts/${d.id}/send`, headers: asUser(admin) })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${staff(co)}/drafts/${d.id}/discard`, headers: asUser(admin) })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `${staff(co)}/drafts/${d.id}`, headers: asUser(admin), payload: { body: "late" } })).statusCode).toBe(409);

    // The portal shows the SENDER, not the agent.
    const pd2 = await app.inject({ method: "GET", url: `${portal(co)}/${generalA}`, headers: asUser(wideA) });
    const pm = (pd2.json() as { messages: MessageRow[] }).messages.find((m) => m.id === sent.id) as MessageRow;
    expect(pm.authorId).toBe(member);
    expect(pm).not.toHaveProperty("draftedBy");
  });

  it("a discarded draft cannot be sent", async () => {
    const draft = await app.inject({ method: "POST", url: `${staff(co)}/${generalA}/drafts`, headers: asUser(member), payload: { body: "maybe" } });
    const id = (draft.json() as { id: string }).id;
    expect((await app.inject({ method: "POST", url: `${staff(co)}/drafts/${id}/discard`, headers: asUser(member) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${staff(co)}/drafts/${id}/send`, headers: asUser(member) })).statusCode).toBe(409);
  });

  it("close (manage) stops replies on both sides; reopen restores them; a bot cannot manage", async () => {
    expect((await app.inject({ method: "PATCH", url: `${staff(co)}/${threadP1}`, headers: asUser(bot), payload: { status: "closed" } })).statusCode).toBe(403);
    const close = await app.inject({ method: "PATCH", url: `${staff(co)}/${threadP1}`, headers: asUser(member), payload: { status: "closed" } });
    expect(close.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${portal(co)}/${threadP1}/messages`, headers: asUser(scopedP1), payload: { body: "x" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${staff(co)}/${threadP1}/messages`, headers: asUser(member), payload: { body: "x" } })).statusCode).toBe(409);
    const reopen = await app.inject({ method: "PATCH", url: `${staff(co)}/${threadP1}`, headers: asUser(member), payload: { status: "open" } });
    expect(reopen.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${portal(co)}/${threadP1}/messages`, headers: asUser(scopedP1), payload: { body: "thanks" } })).statusCode).toBe(201);
    const ev = await adminPool().query(
      `SELECT payload FROM outbox_events WHERE event_type = 'conversation.thread.updated' AND entity_id = $1`, [threadP1],
    );
    expect(ev.rows.length).toBe(2);
    for (const e of ev.rows) expect(e.payload.clientId).toBe(clientA);
  });
});
