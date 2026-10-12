// PV4-06 — notifications for client Conversation, both ways, over HTTP against real Postgres (RLS) + Cerbos.
//   * who is told (staff recipients: participants + project owner + account manager; contacts: the thread's own scope)
//   * the notification rows themselves (type, href, payload; never the message text)
//   * a failing notify() never fails or undoes the post
//   * the client mail type: its flag (default OFF) and its throttle (one mail per contact per thread until read)
//   * the two counts: portal `conversationUnread`, staff `conversationsAwaitingReply` (+ `needsUs`)
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-06; design decision 5; PV4-Q1). BFF: §29d.
//
// Every claim is checked against the STORED rows through adminPool (RLS bypassed), by user id, never inferred from a 2xx.
// Needs DATABASE_URL_TEST + a Cerbos loaded with the current policies. Runs on the Linux gate; skipped elsewhere, and a skip
// is not a pass. The two flag/allow-list unit checks at the bottom run everywhere.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { setStorageForTest, localStorage as diskStorage, type StorageBackend } from "./storage";
import { mailAllowlistedNotificationTypes } from "../mail/intake";
import { notifyClientPosted, resolveContactRecipients, resolveStaffRecipients } from "./conversation-notify";

// A forced notify() failure, switchable per test. The wrapper delegates to the real notify() otherwise.
const ctl = vi.hoisted(() => ({ notifyThrows: false }));
vi.mock("./http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http")>();
  return {
    ...actual,
    notify: vi.fn(async (...args: Parameters<typeof actual.notify>) => {
      if (ctl.notifyThrows) throw new Error("forced notify failure (test)");
      return actual.notify(...args);
    }),
  };
});
import { buildApp } from "../main";

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

/** Distinctive text that must never appear in any notification or mail row. */
const SECRET = "ZZ-SECRET-BODY-9f3a";
const SECRET_SUBJECT = "ZZ-SECRET-SUBJECT-9f3a";

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

describe("PV4-06 unit: the mail allow-list and the client-mail flag", () => {
  it("the allow-list is the two approval types plus conversation.message.staff, and nothing else", () => {
    expect(mailAllowlistedNotificationTypes().sort()).toEqual(["approval.requested", "conversation.message.staff", "pipeline.gate.opened"]);
  });

  it("the client-mail flag defaults OFF (only the exact string '1' turns it on)", () => {
    // Skipped when an operator exported it for this very run; CI does not.
    if (process.env.CONVERSATION_CLIENT_MAIL_ENABLED !== undefined) return;
    expect(config.mail.conversationClientMailEnabled).toBe(false);
  });
});

describe.skipIf(!TEST_URL)("PV4-06: conversation notifications (portal + staff + mail)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let p1: string;       // clientA, owned by ownerP1
  let p2: string;       // clientA, no owner

  // staff
  let admin: string;    // company_admin: posts
  let member2: string;  // member: a second staff participant
  let ownerP1: string;  // owns p1 (never posts)
  let acctMgr: string;  // clientA's account manager (never posts)
  let bot: string;      // users.kind = 'bot': drafts

  // contacts of clientA
  let wideA: string;
  let scopedP1: string;
  let scopedP2: string;
  let revokedA: string;

  const P = (tenant: string) => `/api/${tenant}/portal/conversation`;
  const S = (tenant: string) => `/api/${tenant}/conversation`;

  let threadP1 = "";
  let generalA = "";
  let threadP2 = "";

  /** Notification rows of one type about one thread, as [user_id...] sorted, plus the raw rows. */
  async function notified(type: string, threadId: string) {
    const r = await adminPool().query<{ user_id: string; payload: Record<string, unknown> }>(
      `SELECT user_id, payload FROM notifications WHERE tenant_id = $1 AND type = $2 AND payload->>'entityId' = $3 ORDER BY user_id`,
      [co, type, threadId],
    );
    return { users: r.rows.map((x) => x.user_id).sort(), rows: r.rows };
  }
  const sorted = (...ids: string[]) => [...ids].sort();

  async function clientPostOpen(user: string, payload: Record<string, unknown>) {
    const r = await app.inject({ method: "POST", url: P(co), headers: asUser(user), payload });
    expect(r.statusCode).toBe(201);
    return r.json() as { threadId: string; messageId: string };
  }
  async function staffPostReply(user: string, threadId: string, body = SECRET) {
    const r = await app.inject({ method: "POST", url: `${S(co)}/${threadId}/messages`, headers: asUser(user), payload: { body } });
    expect(r.statusCode).toBe(201);
  }
  async function clientPostReply(user: string, threadId: string, body = SECRET) {
    const r = await app.inject({ method: "POST", url: `${P(co)}/${threadId}/messages`, headers: asUser(user), payload: { body } });
    expect(r.statusCode).toBe(201);
  }
  async function staffOpen(user: string, payload: Record<string, unknown>) {
    const r = await app.inject({ method: "POST", url: S(co), headers: asUser(user), payload: { body: SECRET, ...payload } });
    expect(r.statusCode).toBe(201);
    return r.json() as { threadId: string; messageId: string };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    setStorageForTest(memoryStorage);

    co = await createCompany("PV4-06 Agency", ["clients", "social"]);
    const clientRole = await createRole("client");
    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");

    const staffUser = async (email: string, role?: string) => {
      const u = await createUser(email);
      await addMembership(co, u);
      if (role) await grantRole(u, role, "company", co);
      return u;
    };
    admin = await staffUser("n-admin@agency.test", adminRole);
    member2 = await staffUser("n-member2@agency.test", memberRole);
    ownerP1 = await staffUser("n-owner-p1@agency.test");
    acctMgr = await staffUser("n-acct-mgr@agency.test");
    bot = await staffUser("n-bot@agency.test", memberRole);
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [bot]);

    clientA = await createClient(co, "PV4N Client A");
    await adminPool().query(`UPDATE clients SET owner_user_id = $1 WHERE id = $2`, [acctMgr, clientA]);
    p1 = await createProject(co, "PV4N A Project 1", ownerP1);
    p2 = await createProject(co, "PV4N A Project 2");
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = ANY($2::uuid[])`, [clientA, [p1, p2]]);

    const contact = async (email: string, client: string, opts: Parameters<typeof addContact>[3] = {}) => {
      const u = await createUser(email);
      await addContact(co, client, u, opts);
      await grantRole(u, clientRole, "company", co);
      return u;
    };
    wideA = await contact("n-wide-a@client.test", clientA, { capability: "viewer" });
    scopedP1 = await contact("n-scoped-p1@client.test", clientA, { capability: "signer", projectId: p1 });
    scopedP2 = await contact("n-scoped-p2@client.test", clientA, { capability: "signer", projectId: p2 });
    revokedA = await contact("n-revoked-a@client.test", clientA, { status: "revoked" });

    app = await buildApp();
  });

  afterAll(async () => {
    config.mail.enabled = false;
    config.mail.conversationClientMailEnabled = false;
    setStorageForTest(diskStorage);
    await app?.close();
    await teardownTestDb();
  });

  afterEach(() => {
    ctl.notifyThrows = false;
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // A client posts: the staff recipients (design decision 5)
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a project thread with an owner: a client's new thread notifies the project owner and the account manager, nobody else", async () => {
    const out = await clientPostOpen(scopedP1, { projectId: p1, subject: SECRET_SUBJECT, body: SECRET });
    threadP1 = out.threadId;
    const n = await notified("conversation.message.client", threadP1);
    expect(n.users).toEqual(sorted(ownerP1, acctMgr));
    for (const row of n.rows) {
      expect(row.payload).toMatchObject({
        title: "New message from PV4N Client A",
        href: `/clients/${clientA}/work/conversation/${threadP1}`,
        entityType: "conversation",
        entityId: threadP1,
        actorId: scopedP1,
      });
      // exactly these keys: a fixed title, the link, the thread id, who acted
      expect(Object.keys(row.payload).sort()).toEqual(["actorId", "entityId", "entityType", "href", "title"]);
    }
  });

  it("a client-wide thread with only an account manager: only the account manager hears (not another project's owner)", async () => {
    const out = await clientPostOpen(wideA, { body: SECRET });
    generalA = out.threadId;
    const n = await notified("conversation.message.client", generalA);
    expect(n.users).toEqual([acctMgr]);
    expect(n.users).not.toContain(ownerP1);
  });

  it("a thread with two staff participants: both are told, with the account manager (no owner on that project)", async () => {
    threadP2 = (await staffOpen(admin, { clientId: clientA, projectId: p2 })).threadId;
    await staffPostReply(member2, threadP2);
    await clientPostReply(scopedP2, threadP2);
    const n = await notified("conversation.message.client", threadP2);
    expect(n.users).toEqual(sorted(admin, member2, acctMgr));
  });

  it("duplicates are removed and the actor is excluded", async () => {
    // One person who is the account manager, the project owner AND a staff participant is told once.
    const dupClient = await createClient(co, "PV4N Dup Client");
    await adminPool().query(`UPDATE clients SET owner_user_id = $1 WHERE id = $2`, [admin, dupClient]);
    const pDup = await createProject(co, "PV4N Dup Project", admin);
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [dupClient, pDup]);
    const wideD = await createUser("n-wide-d@client.test");
    await addContact(co, dupClient, wideD);
    await grantRole(wideD, await createRole("client"), "company", co);
    const dupThread = (await staffOpen(admin, { clientId: dupClient, projectId: pDup })).threadId;
    await clientPostReply(wideD, dupThread);
    const n = await notified("conversation.message.client", dupThread);
    expect(n.users).toEqual([admin]);
    expect(n.rows).toHaveLength(1);

    // The resolver itself: deduplicated, and the actor never in the set (member2 posted on threadP2, so would otherwise be in it).
    const forP2 = await withTenants([co], (c) =>
      resolveStaffRecipients(c, { threadId: threadP2, clientId: clientA, projectId: p2, actorId: member2 }));
    expect(forP2).toEqual(sorted(admin, acctMgr));
    const forDup = await withTenants([co], (c) =>
      resolveStaffRecipients(c, { threadId: dupThread, clientId: dupClient, projectId: pDup, actorId: null }));
    expect(forDup).toEqual([admin]);
  });

  it("an empty recipient set notifies nobody and the post still succeeds; the thread shows as awaiting reply", async () => {
    const lonely = await createClient(co, "PV4N Lonely Client");   // no account manager
    const lonelyContact = await createUser("n-wide-lonely@client.test");
    await addContact(co, lonely, lonelyContact);
    await grantRole(lonelyContact, await createRole("client"), "company", co);
    const out = await clientPostOpen(lonelyContact, { body: SECRET });
    expect((await notified("conversation.message.client", out.threadId)).users).toEqual([]);
    const list = await app.inject({ method: "GET", url: `${S(co)}?awaitingReply=true&clientId=${lonely}`, headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { threads: Array<{ id: string }> }).threads.map((t) => t.id)).toEqual([out.threadId]);
  });

  it("an inactive account manager is dropped (and nobody else is invented)", async () => {
    const gone = await createUser("n-disabled-mgr@agency.test");
    await addMembership(co, gone);
    await adminPool().query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [gone]);
    const c3 = await createClient(co, "PV4N Inactive-Mgr Client");
    await adminPool().query(`UPDATE clients SET owner_user_id = $1 WHERE id = $2`, [gone, c3]);
    const contact3 = await createUser("n-wide-c3@client.test");
    await addContact(co, c3, contact3);
    await grantRole(contact3, await createRole("client"), "company", co);
    const out = await clientPostOpen(contact3, { body: SECRET });
    expect((await notified("conversation.message.client", out.threadId)).users).toEqual([]);
    const ids = await withTenants([co], (c) =>
      resolveStaffRecipients(c, { threadId: out.threadId, clientId: c3, projectId: null, actorId: null }));
    expect(ids).toEqual([]);
  });

  it("notifyClientPosted on a thread that does not exist returns [] and does not throw", async () => {
    await expect(notifyClientPosted(co, wideA, newId())).resolves.toEqual([]);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Staff post / a draft is sent: the contacts in the thread's scope
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a staff post on a project thread notifies the client-wide contact and that project's contact, and NOBODY scoped to another project", async () => {
    await staffPostReply(admin, threadP1);
    const n = await notified("conversation.message.staff", threadP1);
    expect(n.users).toEqual(sorted(wideA, scopedP1));
    expect(n.users).not.toContain(scopedP2);   // a contact scoped to ANOTHER project gets nothing
    expect(n.users).not.toContain(revokedA);   // a revoked contact gets nothing
    for (const row of n.rows) {
      expect(row.payload).toMatchObject({
        title: "You have a new message", href: `/portal/conversation/${threadP1}`, entityType: "conversation", entityId: threadP1, actorId: admin,
      });
      expect(Object.keys(row.payload).sort()).toEqual(["actorId", "entityId", "entityType", "href", "title"]);
    }
  });

  it("a staff post on the client-wide thread notifies ONLY client-wide contacts (PV4-Q1)", async () => {
    await staffPostReply(admin, generalA);
    const n = await notified("conversation.message.staff", generalA);
    expect(n.users).toEqual([wideA]);
    expect(n.users).not.toContain(scopedP1);
    expect(n.users).not.toContain(scopedP2);
    // the resolver, directly: the client-wide thread has projectId null
    const ids = await withTenants([co], (c) => resolveContactRecipients(c, { clientId: clientA, projectId: null, actorId: admin }));
    expect(ids).toEqual([wideA]);
  });

  it("sending a draft notifies the contacts too, and creating one notifies the staff recipients once (a replay does not repeat it)", async () => {
    const before = (await notified("conversation.message.staff", threadP1)).rows.filter((r) => r.user_id === wideA).length;

    const d = await app.inject({
      method: "POST", url: `${S(co)}/${threadP1}/drafts`, headers: asUser(bot), payload: { body: SECRET, idempotencyKey: "pv4-06-draft-1" },
    });
    expect(d.statusCode).toBe(201);
    const draftId = (d.json() as { id: string }).id;
    // staff participants of threadP1: admin (posted). Plus the project owner and the account manager. The bot (actor) is none of them.
    const created = await notified("conversation.draft.created", threadP1);
    expect(created.users).toEqual(sorted(admin, ownerP1, acctMgr));
    for (const row of created.rows) {
      expect(row.payload).toMatchObject({
        title: "A draft reply is waiting", href: `/clients/${clientA}/work/conversation/${threadP1}`, entityType: "conversation", entityId: threadP1,
      });
    }
    // a replay of the same key creates no second draft and no second notice
    const replay = await app.inject({
      method: "POST", url: `${S(co)}/${threadP1}/drafts`, headers: asUser(bot), payload: { body: SECRET, idempotencyKey: "pv4-06-draft-1" },
    });
    expect((replay.json() as { replayed: boolean }).replayed).toBe(true);
    expect((await notified("conversation.draft.created", threadP1)).rows).toHaveLength(3);
    // a draft is not a message: no contact was told yet
    expect((await notified("conversation.message.staff", threadP1)).rows.filter((r) => r.user_id === wideA)).toHaveLength(before);

    const sent = await app.inject({ method: "POST", url: `${S(co)}/drafts/${draftId}/send`, headers: asUser(member2) });
    expect(sent.statusCode).toBe(201);
    const after = await notified("conversation.message.staff", threadP1);
    expect(after.rows.filter((r) => r.user_id === wideA)).toHaveLength(before + 1);
    expect(after.users).not.toContain(scopedP2);
    expect(after.users).not.toContain(member2);   // the sender is the actor
  });

  it("no notification payload contains a message body or a thread subject", async () => {
    const all = await adminPool().query<{ type: string; text: string }>(
      `SELECT type, payload::text AS text FROM notifications WHERE tenant_id = $1 AND type LIKE 'conversation.%'`, [co],
    );
    expect(all.rows.length).toBeGreaterThan(10);   // the check is not vacuous: many conversation notices exist by now
    for (const r of all.rows) {
      expect(r.text, `${r.type} payload`).not.toContain(SECRET);
      expect(r.text, `${r.type} payload`).not.toContain(SECRET_SUBJECT);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // A failing notify() never fails the post
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  it("a notify() that throws does not fail or undo a client post, a staff post, or a draft", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ctl.notifyThrows = true;
      const beforeCount = (await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND type LIKE 'conversation.%'`, [co])).rows[0].n;

      const c = await app.inject({ method: "POST", url: `${P(co)}/${threadP1}/messages`, headers: asUser(scopedP1), payload: { body: "stub client" } });
      expect(c.statusCode).toBe(201);
      const s = await app.inject({ method: "POST", url: `${S(co)}/${threadP1}/messages`, headers: asUser(admin), payload: { body: "stub staff" } });
      expect(s.statusCode).toBe(201);
      const d = await app.inject({ method: "POST", url: `${S(co)}/${threadP1}/drafts`, headers: asUser(bot), payload: { body: "stub draft" } });
      expect(d.statusCode).toBe(201);

      // the writes are stored...
      const stored = await adminPool().query(`SELECT body FROM conversation_messages WHERE thread_id = $1 AND body = ANY($2::text[])`, [threadP1, ["stub client", "stub staff"]]);
      expect(stored.rows.map((r) => r.body).sort()).toEqual(["stub client", "stub staff"]);
      const draft = await adminPool().query(`SELECT 1 FROM conversation_drafts WHERE id = $1`, [(d.json() as { id: string }).id]);
      expect(draft.rows).toHaveLength(1);
      // ...no notification was written, and the failure was logged loudly, never swallowed silently.
      const afterCount = (await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND type LIKE 'conversation.%'`, [co])).rows[0].n;
      expect(afterCount).toBe(beforeCount);
      expect(err.mock.calls.some((a) => String(a[0]).includes("[client-notify] notify failed"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // Mail to client contacts: the flag (default OFF) and the throttle
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  describe("mail", () => {
    const mailRows = async (userId: string, threadId: string) =>
      (await adminPool().query<{
        template_key: string; stream: string; status: string; to_email: string; entity_type: string | null;
        reply_token: string | null; payload: Record<string, unknown>; subject: string;
      }>(
        `SELECT template_key, stream, status, to_email, entity_type, reply_token, payload, subject FROM mail_log
          WHERE user_id = $1 AND template_key = 'conversation.message.staff' AND payload->>'threadId' = $2 ORDER BY created_at`,
        [userId, threadId],
      )).rows;

    afterEach(() => {
      config.mail.enabled = false;
      config.mail.conversationClientMailEnabled = false;
    });

    it("OFF by default: with the master gate on and the conversation flag off, NO mail_log row and NO enqueue; the in-app notice still lands", async () => {
      config.mail.enabled = true;
      config.mail.conversationClientMailEnabled = false;
      const rowsBefore = (await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE template_key = 'conversation.message.staff'`)).rows[0].n;
      const inAppBefore = (await notified("conversation.message.staff", threadP2)).rows.length;

      await staffPostReply(admin, threadP2);

      expect((await notified("conversation.message.staff", threadP2)).rows.length).toBeGreaterThan(inAppBefore);
      const rowsAfter = (await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE template_key = 'conversation.message.staff'`)).rows[0].n;
      expect(rowsAfter).toBe(rowsBefore);
    });

    it("the conversation flag alone does nothing while the master gate is off", async () => {
      config.mail.enabled = false;
      config.mail.conversationClientMailEnabled = true;
      const before = (await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE template_key = 'conversation.message.staff'`)).rows[0].n;
      await staffPostReply(admin, threadP2);
      const after = (await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE template_key = 'conversation.message.staff'`)).rows[0].n;
      expect(after).toBe(before);
    });

    it("two staff messages queue ONE mail per contact; after the contact reads the thread, the next queues a second", async () => {
      config.mail.enabled = true;
      config.mail.conversationClientMailEnabled = true;
      await adminPool().query(`DELETE FROM mail_log WHERE template_key = 'conversation.message.staff'`);

      await staffPostReply(admin, threadP1);
      await staffPostReply(admin, threadP1);
      expect(await mailRows(wideA, threadP1)).toHaveLength(1);
      expect(await mailRows(scopedP1, threadP1)).toHaveLength(1);

      // wideA opens the thread (marks it read); scopedP1 does not.
      const read = await app.inject({ method: "GET", url: `${P(co)}/${threadP1}`, headers: asUser(wideA) });
      expect(read.statusCode).toBe(200);
      await staffPostReply(admin, threadP1);

      const wide = await mailRows(wideA, threadP1);
      expect(wide).toHaveLength(2);
      expect(await mailRows(scopedP1, threadP1)).toHaveLength(1);   // per contact: scopedP1 never read, so still one

      // what the mail is: a fixed subject, no reply token, no message text, and ONLY the plain deep link
      const m = wide[0];
      expect(m).toMatchObject({
        template_key: "conversation.message.staff", stream: "notify", to_email: "n-wide-a@client.test",
        entity_type: null, reply_token: null, subject: "You have a new message",
      });
      expect(m.payload.threadId).toBe(threadP1);
      expect(m.payload.href).toBe(`${config.mail.linkBaseUrl}/portal/conversation/${threadP1}`);
      const text = JSON.stringify(m);
      expect(text).not.toContain("ZZ-SECRET");
      expect(text).not.toMatch(/token=/i);
    });

    it("the throttle is per thread: a different thread still mails a contact who is up to date on the first", async () => {
      config.mail.enabled = true;
      config.mail.conversationClientMailEnabled = true;
      await adminPool().query(`DELETE FROM mail_log WHERE template_key = 'conversation.message.staff'`);
      await staffPostReply(admin, threadP2);
      await staffPostReply(admin, generalA);
      expect(await mailRows(wideA, threadP2)).toHaveLength(1);
      expect(await mailRows(wideA, generalA)).toHaveLength(1);
      // scopedP1 is not in scope of threadP2 or the general thread: no mail at all
      expect(await mailRows(scopedP1, threadP2)).toHaveLength(0);
      expect(await mailRows(scopedP1, generalA)).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // The two counts
  // ════════════════════════════════════════════════════════════════════════════════════════════════

  describe("counts", () => {
    let clientK: string;
    let k1: string;
    let k2: string;
    let wideK: string;
    let scopedK1: string;
    let tGeneral = "";
    let tK1 = "";
    let tK2 = "";

    const portalOverview = async (user: string) => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/portal/overview`, headers: asUser(user) });
      expect(r.statusCode).toBe(200);
      return r.json() as { conversationUnread: number };
    };
    const portalList = async (user: string) => {
      const r = await app.inject({ method: "GET", url: P(co), headers: asUser(user) });
      return (r.json() as { threads: Array<{ id: string; unreadCount: number }> }).threads;
    };
    const staffOverview = async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientK}/overview`, headers: asUser(admin) });
      expect(r.statusCode).toBe(200);
      return r.json() as {
        conversationsAwaitingReply: number;
        needsUs: Array<{ kind: string; id: string; href: string; label: string; context: string; clientVisible: boolean }>;
      };
    };

    beforeAll(async () => {
      clientK = await createClient(co, "PV4N Counts Client");
      k1 = await createProject(co, "PV4N K1");
      k2 = await createProject(co, "PV4N K2");
      await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = ANY($2::uuid[])`, [clientK, [k1, k2]]);
      const role = await createRole("client");
      wideK = await createUser("n-wide-k@client.test");
      await addContact(co, clientK, wideK, { capability: "viewer" });
      await grantRole(wideK, role, "company", co);
      scopedK1 = await createUser("n-scoped-k1@client.test");
      await addContact(co, clientK, scopedK1, { projectId: k1 });
      await grantRole(scopedK1, role, "company", co);
    });

    it("conversationUnread counts THREADS with unread staff messages in the caller's scope, by the same rule as the list", async () => {
      expect((await portalOverview(wideK)).conversationUnread).toBe(0);
      tGeneral = (await staffOpen(admin, { clientId: clientK })).threadId;
      tK1 = (await staffOpen(admin, { clientId: clientK, projectId: k1 })).threadId;
      tK2 = (await staffOpen(admin, { clientId: clientK, projectId: k2 })).threadId;

      expect((await portalOverview(wideK)).conversationUnread).toBe(3);
      // a project-scoped contact: only their project's thread (PV4-Q1: not the client-wide one)
      expect((await portalOverview(scopedK1)).conversationUnread).toBe(1);

      // reading the general thread clears it; a second staff message in tK1 adds a MESSAGE, not a thread
      expect((await app.inject({ method: "GET", url: `${P(co)}/${tGeneral}`, headers: asUser(wideK) })).statusCode).toBe(200);
      await staffPostReply(admin, tK1);
      const o = await portalOverview(wideK);
      expect(o.conversationUnread).toBe(2);
      // parity with the list's per-thread unreadCount (PV4-03's rule, not a fork of it)
      expect((await portalList(wideK)).filter((t) => t.unreadCount > 0).length).toBe(o.conversationUnread);
      expect((await portalList(scopedK1)).filter((t) => t.unreadCount > 0).length).toBe((await portalOverview(scopedK1)).conversationUnread);

      // answering a thread marks it read for the poster
      await clientPostReply(wideK, tK1);
      expect((await portalOverview(wideK)).conversationUnread).toBe(1);
    });

    it("conversationsAwaitingReply and needsUs: last non-retracted message is the client's, open threads only", async () => {
      // tK1 holds a client reply from the previous test (last message = client); tGeneral and tK2 end with staff.
      let o = await staffOverview();
      expect(o.conversationsAwaitingReply).toBe(1);
      const item = o.needsUs.find((i) => i.kind === "conversation");
      expect(item).toMatchObject({
        id: tK1, href: `/clients/${clientK}/work/conversation/${tK1}`, label: "A client message is waiting for our reply",
        context: "PV4N K1", clientVisible: true,
      });

      // the client posts on the general thread too
      await clientPostReply(wideK, tGeneral);
      o = await staffOverview();
      expect(o.conversationsAwaitingReply).toBe(2);
      expect(o.needsUs.filter((i) => i.kind === "conversation").map((i) => i.id).sort()).toEqual(sorted(tK1, tGeneral));
      // the staff list's own awaitingReply filter agrees (one rule, shared)
      const list = await app.inject({ method: "GET", url: `${S(co)}?awaitingReply=true&clientId=${clientK}`, headers: asUser(admin) });
      expect((list.json() as { threads: Array<{ id: string }> }).threads.map((t) => t.id).sort()).toEqual(sorted(tK1, tGeneral));

      // a staff reply answers it
      await staffPostReply(admin, tK1);
      expect((await staffOverview()).conversationsAwaitingReply).toBe(1);

      // a retracted client message does not count: the last LIVE message on tK2 is the staff opener
      const posted = await app.inject({ method: "POST", url: `${P(co)}/${tK2}/messages`, headers: asUser(wideK), payload: { body: "oops" } });
      expect((await staffOverview()).conversationsAwaitingReply).toBe(2);
      const retract = await app.inject({ method: "DELETE", url: `${P(co)}/messages/${(posted.json() as { id: string }).id}`, headers: asUser(wideK) });
      expect(retract.statusCode).toBe(200);
      expect((await staffOverview()).conversationsAwaitingReply).toBe(1);

      // a closed thread is not awaiting; reopening brings it back
      const close = await app.inject({ method: "PATCH", url: `${S(co)}/${tGeneral}`, headers: asUser(admin), payload: { status: "closed" } });
      expect(close.statusCode).toBe(200);
      expect((await staffOverview()).conversationsAwaitingReply).toBe(0);
      await app.inject({ method: "PATCH", url: `${S(co)}/${tGeneral}`, headers: asUser(admin), payload: { status: "open" } });
      expect((await staffOverview()).conversationsAwaitingReply).toBe(1);
    });
  });
});
