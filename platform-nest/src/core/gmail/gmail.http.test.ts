// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48.6) — email from the ERP through your OWN Gmail, driven over HTTP against real Postgres (RLS on) and real
// Cerbos, in SIMULATED mode (the default; live mode is not exercised in this ticket: its token handling is covered with a stubbed fetch in
// gmail.service.test.ts, and no test here touches the network).
//
// What is covered (each bullet of §48.6 that needs a database or the policy):
//   * connect, status and disconnect in simulated mode: the row, the audit rows, the gate for every role (and for an agent, a stranger, a client);
//   * reading: the fixture mailbox, the label and page token checks, a thread with sanitized HTML and attachment METADATA only;
//   * ANOTHER PERSON'S MAILBOX IS UNREACHABLE: no route takes an owner; every owner-shaped query parameter and header is ignored; a company_admin
//     and a platform_admin reach only their own; a connection row forged for someone else (any owner, any kind) is never read;
//   * send: 409 without a connection, the 400s with their `field`, authorisation BEFORE validation, a reply keeping its thread, "Email this client"
//     (the client's read, an unknown or other-company client), the `emailed` activity row carrying NO subject, body or address, the 31st send in an
//     hour 429 with `retryAfterSeconds`, an automation or bot principal refused;
//   * NOTHING IS STORED: reads write no row anywhere, and a scan of every table that could hold a copy finds none of the strings sent.
//
// Standard applied throughout: a 200 is not a pass. Every write claim is read back through `adminPool()` (bypassing RLS, so what is asserted is what
// committed), and every refusal also asserts that nothing was written and nothing was sent.
//
// Needs the Linux gate (DATABASE_URL_TEST + a Cerbos loaded with the CURRENT policy files, restarted after the resource_personal_mailbox.yaml
// edit). It SKIPS without a database; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { setGmailHttpForTests, setSendLimiterForTests, simulatedMailboxes } from "./service";

// Fault injection for ONE case: a sender who may not read the client. No role combination in the shipped policies produces that (every role that
// may send also reads clients), so the controller's wiring of the client read is proved by making that single Cerbos answer a denial.
const fault = vi.hoisted(() => ({ denyClientRead: false }));
vi.mock("../http", async (orig) => {
  const actual = await orig<typeof import("../http")>();
  return {
    ...actual,
    authorize: async (...args: Parameters<typeof actual.authorize>) => {
      const [, resource, action] = args;
      if (fault.denyClientRead && resource.kind === "client" && action === "read") throw new ForbiddenException("not authorized: injected client denial");
      return actual.authorize(...args);
    },
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// Strings that must never be found in the database or a log once sent through the mailbox.
const SECRET_SUBJECT = "DW8J-SECRET-SUBJECT-5f1c";
const SECRET_BODY = "DW8J-SECRET-BODY-9a2e";
const SECRET_ADDR = "dw8j-secret-recipient-3b7d@example.test";
const SECRET_CC = "dw8j-secret-cc-4c8e@example.test";
const NIL = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!TEST_URL)("DW-8j Gmail through your own mailbox (HTTP, real Postgres + Cerbos, simulated mode)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let mem: string; // member
  let mem2: string; // member
  let mgr: string; // manager only
  let adm: string; // company_admin
  let pa: string; // platform_admin (global), also a member of A
  let view: string; // viewer
  let stranger: string; // no membership, no grant
  let portal: string; // a client-kind portal login (client role only)
  let botU: string; // member role, users.kind = 'bot'
  let autoU: string; // member role, users.kind = 'automation'
  let clientA: string;
  let clientB: string;
  const saved = { ...config.gmail };
  const logs: string[] = [];

  const q = adminPool;
  async function call(method: "GET" | "POST" | "DELETE", url: string, userId: string, payload?: unknown, headers: Record<string, string> = {}) {
    return app.inject({ method, url, headers: { ...asUser(userId), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  }
  const json = (r: { json: () => unknown }) => r.json() as Record<string, any>;
  const reasonOf = (r: { json: () => unknown }) => json(r).reason as string;
  const base = (t = A) => `/api/${t}`;
  const status = (as: string, t = A) => call("GET", `${base(t)}/integrations/gmail`, as);
  const start = (as: string, t = A) => call("GET", `${base(t)}/integrations/gmail/oauth/start`, as);
  const disconnect = (as: string, t = A) => call("DELETE", `${base(t)}/integrations/gmail`, as);
  const threads = (as: string, qs = "", t = A, headers: Record<string, string> = {}) => call("GET", `${base(t)}/mail/me/threads${qs}`, as, undefined, headers);
  const thread = (as: string, id: string, t = A) => call("GET", `${base(t)}/mail/me/threads/${id}`, as);
  const send = (as: string, body: unknown, t = A) => call("POST", `${base(t)}/mail/me/send`, as, body);
  const good = (over: Record<string, unknown> = {}) => ({ to: [SECRET_ADDR], cc: [SECRET_CC], subject: SECRET_SUBJECT, body: SECRET_BODY, ...over });

  async function connect(as: string, t = A) {
    const r = await start(as, t);
    expect(r.statusCode, r.body).toBe(200);
    return r;
  }
  const rows = async (userId: string, t = A) =>
    (await q().query(`SELECT * FROM integration_connections WHERE tenant_id = $1 AND owner_kind = 'user' AND owner_id = $2 AND provider = 'google_gmail'`, [t, userId])).rows;
  const count = async (sql: string, args: unknown[] = []) => Number((await q().query(sql, args)).rows[0].n);
  const activities = async (verb: string, actor: string, t = A) =>
    (await q().query(`SELECT * FROM activities WHERE tenant_id = $1 AND verb = $2 AND actor_id = $3 ORDER BY occurred_at, id`, [t, verb, actor])).rows;
  const sentCount = (userId: string) => simulatedMailboxes.sentCount(userId);
  /** An activity row's metadata without `via` (the request channel the platform adds to EVERY activity row; it says how the call arrived, never
   *  anything about the mailbox). What remains is exactly what the controller wrote. */
  const meta = (row: { metadata: Record<string, unknown> }) => {
    const { via: _via, ...rest } = row.metadata;
    return rest;
  };
  /** A snapshot of every table a reader could write to: reads must leave it byte-for-byte alone. */
  const writes = async () => ({
    activities: await count(`SELECT count(*)::int AS n FROM activities`),
    notifications: await count(`SELECT count(*)::int AS n FROM notifications`),
    outbox: await count(`SELECT count(*)::int AS n FROM outbox_events`),
    connections: await count(`SELECT count(*)::int AS n FROM integration_connections`),
    files: await count(`SELECT count(*)::int AS n FROM files`),
  });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    Object.assign(config.gmail, { mode: "simulated", clientId: "", clientSecret: "", redirectUri: "" });
    // No test in this file may reach the network: any Google call would fail loudly.
    setGmailHttpForTests((async (url: unknown) => {
      throw new Error(`the simulated Gmail suite tried to reach the network: ${String(url)}`);
    }) as unknown as typeof fetch);
    for (const k of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
    }

    A = await createCompany("Gmail Co A", ["clients"]);
    B = await createCompany("Gmail Co B", ["clients"]);
    const mk = async (key: string, tenants: string[] = [A]) => {
      const id = await createUser(`${key}@dw8j.test`, key);
      for (const t of tenants) await addMembership(t, id);
      return id;
    };
    mem = await mk("mem"); mem2 = await mk("mem2"); mgr = await mk("mgr"); adm = await mk("adm"); pa = await mk("pa"); view = await mk("view");
    stranger = await mk("stranger", []); portal = await mk("portal"); botU = await mk("bot"); autoU = await mk("auto");
    const role = {
      member: await createRole("member"), manager: await createRole("manager"), admin: await createRole("company_admin"),
      viewer: await createRole("viewer"), pa: await createRole("platform_admin"), client: await createRole("client"),
    };
    for (const u of [mem, mem2, botU, autoU]) await grantRole(u, role.member, "company", A);
    await grantRole(mgr, role.manager, "company", A);
    await grantRole(adm, role.admin, "company", A);
    await grantRole(pa, role.pa, "global", null);
    await grantRole(view, role.viewer, "company", A);
    await grantRole(portal, role.client, "company", A);
    await q().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botU]);
    await q().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [autoU]);
    await q().query(`UPDATE users SET kind = 'client' WHERE id = $1`, [portal]);
    clientA = await createClient(A, "Gmail Client A");
    clientB = await createClient(B, "Gmail Client B");
    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    setGmailHttpForTests(null);
    setSendLimiterForTests(null);
    Object.assign(config.gmail, saved);
    vi.restoreAllMocks();
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    fault.denyClientRead = false;
    simulatedMailboxes.clear();
    setSendLimiterForTests(null);
    await q().query(`DELETE FROM activities WHERE verb IN ('emailed', 'connected', 'disconnected') AND tenant_id = ANY($1::uuid[])`, [[A, B]]);
    await q().query(`DELETE FROM integration_connections WHERE provider = 'google_gmail'`);
  });

  // ═══════════════════════════════════════════════ the connection (§48.2) ═══════════════════════════════════════════════

  describe("connect, status and disconnect (simulated)", () => {
    it("a fresh person's status is {configured, connected:false, ...} with mode simulated, and asking writes nothing (the Cerbos-restart probe)", async () => {
      const before = await writes();
      const r = await status(mem);
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toEqual({ configured: true, connected: false, needsReconnect: false, accountEmail: null, mode: "simulated" });
      expect(await writes()).toEqual(before);
    });

    it("start links the simulated mailbox at once: one linked row of the person's own, no token, no OAuth state, an audit row without the address", async () => {
      const r = await connect(mem);
      expect(json(r)).toMatchObject({ mode: "simulated", linked: true });
      expect(json(r).accountEmail).toMatch(/^me\.[0-9a-f]{8}@simulated\.invalid$/);
      expect(Object.keys(json(r)).sort()).toEqual(["accountEmail", "linked", "mode"]);
      const row = await rows(mem);
      expect(row).toHaveLength(1);
      expect(row[0]).toMatchObject({ owner_kind: "user", owner_id: mem, provider: "google_gmail", status: "linked", access_token_enc: null, refresh_token_enc: null, tenant_id: A });
      expect(row[0].meta.gmailMode).toBe("simulated");
      expect(await count(`SELECT count(*)::int AS n FROM google_oauth_states WHERE provider = 'google_gmail'`)).toBe(0);
      const act = await activities("connected", mem);
      expect(act).toHaveLength(1);
      expect(meta(act[0])).toEqual({ provider: "google_gmail", mode: "simulated" });
      expect(JSON.stringify(act[0])).not.toContain("simulated.invalid");
      expect(json(await status(mem))).toEqual({ configured: true, connected: true, needsReconnect: false, accountEmail: json(r).accountEmail, mode: "simulated" });
    });

    it("connecting again is the same row (one row per person), and another person's status is untouched", async () => {
      await connect(mem);
      await connect(mem);
      expect(await rows(mem)).toHaveLength(1);
      expect(json(await status(mem2))).toMatchObject({ connected: false, accountEmail: null });
    });

    it("disconnect clears the link and forgets the simulated Sent; a second disconnect says nothing was linked; reconnecting starts empty", async () => {
      await connect(mem);
      expect((await send(mem, good())).statusCode).toBe(202);
      expect(sentCount(mem)).toBe(1);
      const d = await disconnect(mem);
      expect(d.statusCode, d.body).toBe(200);
      expect(json(d)).toEqual({ disconnected: true, revokedAtGoogle: null, mode: "simulated" });
      expect((await rows(mem))[0]).toMatchObject({ status: "revoked", access_token_enc: null, refresh_token_enc: null });
      expect(sentCount(mem)).toBe(0);
      expect(meta((await activities("disconnected", mem))[0])).toEqual({ provider: "google_gmail", mode: "simulated", revokedAtGoogle: null });
      expect(json(await status(mem))).toMatchObject({ connected: false });
      expect(json(await disconnect(mem))).toMatchObject({ disconnected: false });
      await connect(mem);
      expect(json(await threads(mem, "?label=SENT")).threads).toEqual([]);
    });

    it("the callback has no Google flow in simulated mode: 400 gmail_state_invalid, nothing written", async () => {
      const before = await writes();
      const r = await call("GET", "/api/gmail/oauth/callback?code=x&state=y", mem);
      expect(r.statusCode).toBe(400);
      expect(reasonOf(r)).toBe("gmail_state_invalid");
      expect(await writes()).toEqual(before);
    });
  });

  describe("who may use it (PERMISSION-CONTRACT §40): the owner's own mailbox, for member, manager, company_admin and platform_admin only", () => {
    it("member, manager, company_admin and platform_admin each connect their OWN mailbox", async () => {
      for (const u of [mem, mgr, adm, pa]) {
        expect((await status(u)).statusCode, `status ${u}`).toBe(200);
        expect((await connect(u)).statusCode).toBe(200);
        expect(json(await status(u))).toMatchObject({ connected: true });
        expect(await rows(u)).toHaveLength(1);
      }
    });

    it("a viewer, a stranger, a portal login, a bot and an automation principal get 403 on status, start and disconnect, and nothing is written", async () => {
      const before = await writes();
      for (const u of [view, stranger, portal, botU, autoU]) {
        for (const r of [await status(u), await start(u), await disconnect(u)]) expect(r.statusCode, `${u} ${r.body}`).toBe(403);
      }
      expect(await count(`SELECT count(*)::int AS n FROM integration_connections WHERE provider = 'google_gmail'`)).toBe(0);
      expect((await writes()).connections).toBe(before.connections);
    });

    it("a bot or automation principal with a forged LINKED row of its own is still refused every read and send", async () => {
      for (const u of [botU, autoU]) {
        await q().query(
          `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, meta, origin_site)
           VALUES ($1, $2, 'user', $3, 'google_gmail', 'linked', '{"gmailMode":"simulated"}', 'test')`,
          [randomUUID(), A, u],
        );
        expect((await threads(u)).statusCode).toBe(403);
        expect((await thread(u, "t5")).statusCode).toBe(403);
        expect((await send(u, good())).statusCode).toBe(403);
        expect(sentCount(u)).toBe(0);
      }
    });

    it("a person who belongs to no company is refused in every company (tenancy), including the other one", async () => {
      expect((await status(mem, B)).statusCode).toBe(403);
      expect((await start(mem, B)).statusCode).toBe(403);
      expect((await send(mem, good(), B)).statusCode).toBe(403);
      expect(await count(`SELECT count(*)::int AS n FROM integration_connections WHERE provider = 'google_gmail' AND tenant_id = $1`, [B])).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════ reading (§48.3) ═══════════════════════════════════════════════

  describe("reading your own mail", () => {
    it("without a connection every read is 409 gmail_not_connected", async () => {
      for (const r of [await threads(mem), await thread(mem, "t5")]) {
        expect(r.statusCode).toBe(409);
        expect(reasonOf(r)).toBe("gmail_not_connected");
        expect(json(r).error.startsWith("gmail_not_connected:")).toBe(true);
      }
    });

    it("lists the fixture INBOX (the default) as rows with exactly the documented fields, SENT empty, and writes nothing", async () => {
      await connect(mem);
      const before = await writes();
      const r = await threads(mem);
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r).mode).toBe("simulated");
      expect(json(r).nextPageToken).toBeNull();
      expect(json(r).threads).toHaveLength(5);
      expect(Object.keys(json(r).threads[0]).sort()).toEqual(["from", "id", "lastMessageDate", "snippet", "subject", "unread"]);
      expect(json(r).threads.find((t: any) => t.id === "t5")).toMatchObject({ unread: true });
      expect(json(await threads(mem, "?label=INBOX"))).toEqual(json(r));
      expect(json(await threads(mem, "?label=SENT")).threads).toEqual([]);
      expect(await writes()).toEqual(before); // nothing is cached or logged to the database
    });

    it("refuses a label that is not INBOX or SENT, and a page token that is not one, with 400 gmail_request_invalid and the field", async () => {
      await connect(mem);
      for (const [qs, field] of [["?label=TRASH", "label"], ["?label=inbox", "label"], ["?label=INBOX&pageToken=has%20space", "pageToken"]] as const) {
        const r = await threads(mem, qs);
        expect(r.statusCode, qs).toBe(400);
        expect(reasonOf(r)).toBe("gmail_request_invalid");
        expect(json(r).field).toBe(field);
      }
      const unknown = await threads(mem, "?pageToken=never-issued");
      expect(unknown.statusCode).toBe(404);
      expect(reasonOf(unknown)).toBe("gmail_not_found");
    });

    it("authorisation comes first: a viewer or a bot sending a bad label gets 403, never 400", async () => {
      for (const u of [view, botU, stranger]) expect((await threads(u, "?label=bogus")).statusCode, u).toBe(403);
    });

    it("reads one thread: decoded messages, the text part, sanitized HTML, attachment metadata only; unknown 404, malformed 400", async () => {
      await connect(mem);
      const html = await thread(mem, "t3");
      expect(html.statusCode, html.body).toBe(200);
      expect(json(html)).toMatchObject({ mode: "simulated", id: "t3" });
      expect(json(html).messages[0].html).toBe("<p>Weekly digest: <b>3 updates</b> this week.</p>");
      expect(json(html).messages[0].text).toContain("Weekly digest");
      const att = json(await thread(mem, "t2")).messages[0].attachments;
      expect(att).toEqual([{ attachmentId: "att-1042", filename: "invoice-A-1042.pdf", mimeType: "application/pdf", sizeBytes: 48213 }]);
      const missing = await thread(mem, "no-such-thread");
      expect(missing.statusCode).toBe(404);
      expect(reasonOf(missing)).toBe("gmail_not_found");
      const bad = await thread(mem, "a%20b");
      expect(bad.statusCode).toBe(400);
      expect(json(bad).field).toBe("threadId");
    });
  });

  // ═══════════════════════════════════════════════ another person's mailbox is unreachable ═══════════════════════════════════════════════

  describe("another person's mailbox is unreachable", () => {
    it("no route takes an owner: every owner-shaped parameter and header is ignored, so a company_admin and a platform_admin read only their OWN Sent", async () => {
      await connect(mem);
      await connect(adm);
      await connect(pa);
      const sent = await send(mem, good({ subject: "mem's private subject" }));
      expect(sent.statusCode, sent.body).toBe(202);
      const memThread = json(sent).threadId;

      const lure = `&userId=${mem}&ownerId=${mem}&owner=${mem}&mailbox=${mem}&as=${mem}&user=${mem}`;
      const lureHeaders = { "x-mailbox-owner": mem, "x-owner-id": mem, "x-act-as": mem };
      for (const u of [adm, pa]) {
        const r = await threads(u, `?label=SENT${lure}`, A, lureHeaders);
        expect(r.statusCode, r.body).toBe(200);
        expect(json(r).threads, `${u} must see their own (empty) Sent, not mem's`).toEqual([]);
        const t = await thread(u, memThread);
        expect(t.statusCode).toBe(404); // mem's thread id does not exist in THEIR mailbox
        expect(reasonOf(t)).toBe("gmail_not_found");
        expect(json(await status(u))).toMatchObject({ connected: true, accountEmail: expect.stringContaining(`me.${u.slice(0, 8)}@`) });
      }
      // mem's own view is intact
      expect(json(await threads(mem, "?label=SENT")).threads.map((t: any) => t.id)).toEqual([memThread]);
      expect(sentCount(adm) + sentCount(pa)).toBe(0);
    });

    it("a person with no mailbox of their own reads nothing through anyone else's: 409, even with the owner named, even beside a connected colleague", async () => {
      await connect(mem);
      await connect(adm);
      for (const lure of [`?userId=${mem}`, `?ownerId=${adm}&label=SENT`]) {
        const r = await threads(mgr, lure, A, { "x-owner-id": mem });
        expect(r.statusCode, lure).toBe(409);
        expect(reasonOf(r)).toBe("gmail_not_connected");
      }
      expect(json(await status(mgr))).toMatchObject({ connected: false, accountEmail: null });
    });

    it("a connection row FORGED for someone else is never read: any owner, any kind, in this or another company", async () => {
      const forge = (tenant: string, ownerKind: string, owner: string, meta = '{"gmailMode":"simulated"}') =>
        q().query(
          `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, external_account, status, meta, origin_site)
           VALUES ($1, $2, $3, $4, 'google_gmail', 'forged@simulated.invalid', 'linked', $5, 'test')`,
          [randomUUID(), tenant, ownerKind, owner, meta],
        );
      await forge(A, "user", mem);       // a perfect simulated link for mem
      await forge(A, "user", adm);       // and for the company_admin
      await forge(A, "company", mgr);    // a company-owned row whose owner_id happens to be mgr's id
      await forge(B, "user", mgr);       // mgr's id, but in ANOTHER company
      await forge(A, "user", pa, '{"gmailMode":"live"}'); // a live-shaped row for the platform_admin
      // mgr has no row of their own, so nothing above may be mgr's
      expect(json(await status(mgr))).toMatchObject({ connected: false, accountEmail: null });
      expect((await threads(mgr)).statusCode).toBe(409);
      expect((await send(mgr, good())).statusCode).toBe(409);
      // pa's only row is live-shaped, which is not a simulated link
      expect(json(await status(pa))).toMatchObject({ connected: false });
      // the forged rows read as the people they name, and ONLY them
      expect(json(await status(mem))).toMatchObject({ connected: true });
      expect(json(await status(adm))).toMatchObject({ connected: true });
      // and a stranger of the company who is not named by any row gets nothing
      expect(json(await status(mem2))).toMatchObject({ connected: false, accountEmail: null });
      expect(sentCount(mgr) + sentCount(pa) + sentCount(mem2)).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════ sending (§48.4) ═══════════════════════════════════════════════

  describe("send", () => {
    it("without a connection: 409 gmail_not_connected, nothing written, and the attempt does not use up the hourly limit", async () => {
      const before = await writes();
      for (let i = 0; i < 35; i++) {
        const r = await send(mem, good());
        expect(r.statusCode).toBe(409);
        expect(reasonOf(r)).toBe("gmail_not_connected");
      }
      expect(await writes()).toEqual(before);
      await connect(mem);
      for (let i = 0; i < 30; i++) expect((await send(mem, good({ subject: `S${i}` }))).statusCode, `send ${i}`).toBe(202);
    });

    it("authorisation comes FIRST: a viewer, a bot, an automation principal, a portal login and a stranger sending an INVALID body get 403, never 400", async () => {
      for (const u of [view, botU, autoU, portal, stranger]) {
        for (const bad of [{}, { to: [] }, "not an object", { ...good(), context: { kind: "project", id: "x" } }]) {
          expect((await send(u, bad)).statusCode, `${u} ${JSON.stringify(bad)}`).toBe(403);
        }
      }
      expect(await count(`SELECT count(*)::int AS n FROM activities WHERE verb = 'emailed'`)).toBe(0);
    });

    it("an automation or bot principal that is otherwise a member is refused send (the policy's agent deny)", async () => {
      for (const u of [botU, autoU]) {
        const r = await send(u, good());
        expect(r.statusCode).toBe(403);
        expect(sentCount(u)).toBe(0);
      }
    });

    it("validates the body AFTER the gate: 400 gmail_send_invalid names the field, and nothing is sent or recorded", async () => {
      await connect(mem);
      const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.test`);
      const cases: Array<[string, unknown, string]> = [
        ["no body at all", {}, "to"],
        ["to missing", { subject: "s", body: "b" }, "to"],
        ["to empty", good({ to: [] }), "to"],
        ["to not a list", good({ to: "a@example.test" }), "to"],
        ["to malformed", good({ to: ["nope"] }), "to"],
        ["to with a display name", good({ to: ["Someone <a@example.test>"] }), "to"],
        ["header injection in to", good({ to: ["a@example.test\r\nBcc: v@example.test"] }), "to"],
        ["cc malformed", good({ cc: ["nope"] }), "cc"],
        ["21 recipients in all", good({ to: ["a@example.test"], cc: many.slice(0, 20) }), "cc"],
        ["subject empty", good({ subject: "" }), "subject"],
        ["subject too long", good({ subject: "x".repeat(301) }), "subject"],
        ["subject with a line break", good({ subject: "Hi\r\nBcc: v@example.test" }), "subject"],
        ["body empty", good({ body: "  " }), "body"],
        ["body too long", good({ body: "x".repeat(50_001) }), "body"],
        ["inReplyTo malformed", good({ inReplyTo: { threadId: "t5" } }), "inReplyTo"],
        ["context of the wrong kind", good({ context: { kind: "project", id: clientA } }), "context"],
        ["context with a malformed id", good({ context: { kind: "client", id: "not-a-uuid" } }), "context"],
      ];
      const before = await writes();
      for (const [label, body, field] of cases) {
        const r = await send(mem, body);
        expect(r.statusCode, `${label}: ${r.body}`).toBe(400);
        expect(reasonOf(r), label).toBe("gmail_send_invalid");
        expect(json(r).field, label).toBe(field);
        expect(json(r).error.startsWith("gmail_send_invalid:"), label).toBe(true);
      }
      expect(sentCount(mem)).toBe(0);
      expect(await writes()).toEqual(before);
    });

    it("sends: 202 {mode, messageId, threadId}; it lands in the person's SENT and can be read back; ONE `emailed` activity row on nobody with ONLY the count and the mode", async () => {
      await connect(mem);
      const before = await writes();
      const r = await send(mem, good());
      expect(r.statusCode, r.body).toBe(202);
      expect(Object.keys(json(r)).sort()).toEqual(["messageId", "mode", "threadId"]);
      expect(json(r).mode).toBe("simulated");

      const list = json(await threads(mem, "?label=SENT"));
      expect(list.threads).toHaveLength(1);
      expect(list.threads[0]).toMatchObject({ id: json(r).threadId, subject: SECRET_SUBJECT });
      const t = json(await thread(mem, json(r).threadId));
      expect(t.messages[0]).toMatchObject({ id: json(r).messageId, subject: SECRET_SUBJECT, to: SECRET_ADDR, cc: SECRET_CC, text: SECRET_BODY });

      const act = await activities("emailed", mem);
      expect(act).toHaveLength(1);
      expect(act[0]).toMatchObject({ actor_id: mem, tenant_id: A, target_entity_type: "personal_mailbox", target_entity_id: null });
      expect(meta(act[0])).toEqual({ recipientCount: 2, mode: "simulated" });
      expect(act[0].occurred_at).toBeTruthy();
      for (const secret of [SECRET_SUBJECT, SECRET_BODY, SECRET_ADDR, SECRET_CC]) expect(JSON.stringify(act[0])).not.toContain(secret);

      const after = await writes();
      expect(after).toEqual({ ...before, activities: before.activities + 1 }); // the activity row, and nothing else (no notification, no event, no file)
    });

    it("counts distinct recipients: a repeated address and an address in both to and cc count once", async () => {
      await connect(mem);
      await send(mem, good({ to: ["a@example.test", "A@example.test"], cc: ["a@example.test", "b@example.test"] }));
      expect(meta((await activities("emailed", mem))[0])).toEqual({ recipientCount: 2, mode: "simulated" });
    });

    it("a reply keeps the thread (In-Reply-To set); a reply to a message that is not there is 404 gmail_not_found and sends nothing", async () => {
      await connect(mem);
      const r = await send(mem, good({ subject: "Re: kickoff", inReplyTo: { threadId: "t5", messageId: "m5c" } }));
      expect(r.statusCode, r.body).toBe(202);
      expect(json(r).threadId).toBe("t5");
      const msgs = json(await thread(mem, "t5")).messages;
      expect(msgs.map((m: any) => m.id)).toEqual(["m5a", "m5b", "m5c", json(r).messageId]);
      expect(msgs[3].inReplyTo).toBe("<m5c@fixture.invalid>");
      const missing = await send(mem, good({ inReplyTo: { threadId: "t5", messageId: "nope" } }));
      expect(missing.statusCode).toBe(404);
      expect(reasonOf(missing)).toBe("gmail_not_found");
      expect(sentCount(mem)).toBe(1);
    });

    it("\"Email this client\": with a readable client context the send is recorded `emailed` ON THAT CLIENT, still with no subject, body or address", async () => {
      await connect(mem);
      const r = await send(mem, good({ context: { kind: "client", id: clientA } }));
      expect(r.statusCode, r.body).toBe(202);
      const act = (await q().query(`SELECT * FROM activities WHERE verb = 'emailed' AND target_entity_id = $1`, [clientA])).rows;
      expect(act).toHaveLength(1);
      expect(act[0]).toMatchObject({ actor_id: mem, tenant_id: A, target_entity_type: "client" });
      expect(meta(act[0])).toEqual({ recipientCount: 2, mode: "simulated" });
      for (const secret of [SECRET_SUBJECT, SECRET_BODY, SECRET_ADDR, SECRET_CC]) expect(JSON.stringify(act[0])).not.toContain(secret);
      expect(await activities("emailed", mem)).toHaveLength(1);
    });

    it("a client of ANOTHER company, or one that does not exist, is a 400 on `context` (RLS hides it) and nothing is sent", async () => {
      await connect(mem);
      for (const id of [clientB, NIL]) {
        const r = await send(mem, good({ context: { kind: "client", id } }));
        expect(r.statusCode, id).toBe(400);
        expect(reasonOf(r)).toBe("gmail_send_invalid");
        expect(json(r).field).toBe("context");
      }
      expect(sentCount(mem)).toBe(0);
      expect(await count(`SELECT count(*)::int AS n FROM activities WHERE verb = 'emailed'`)).toBe(0);
    });

    it("a caller who cannot read the client cannot send \"about\" it: 403 before the body is looked at, nothing sent, nothing recorded (fault-injected read denial)", async () => {
      await connect(mem);
      fault.denyClientRead = true;
      for (const body of [good({ context: { kind: "client", id: clientA } }), { context: { kind: "client", id: clientA } }, { context: { kind: "client" } }]) {
        const r = await send(mem, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(403);
      }
      fault.denyClientRead = false;
      expect(sentCount(mem)).toBe(0);
      expect(await count(`SELECT count(*)::int AS n FROM activities WHERE verb = 'emailed'`)).toBe(0);
      expect((await send(mem, good({ context: { kind: "client", id: clientA } }))).statusCode).toBe(202); // the gate, not the connection, was what refused
    });

    it("the 31st send in an hour is 429 gmail_send_rate_limited with retryAfterSeconds (body and Retry-After); the 30 before it were delivered; others are unaffected", async () => {
      await connect(mem);
      await connect(mem2);
      for (let i = 0; i < 30; i++) expect((await send(mem, good({ subject: `S${i}` }))).statusCode, `send ${i}`).toBe(202);
      const r = await send(mem, good());
      expect(r.statusCode, r.body).toBe(429);
      expect(reasonOf(r)).toBe("gmail_send_rate_limited");
      expect(json(r).error.startsWith("gmail_send_rate_limited:")).toBe(true);
      expect(json(r).retryAfterSeconds).toBeGreaterThan(3500);
      expect(json(r).retryAfterSeconds).toBeLessThanOrEqual(3600);
      expect(r.headers["retry-after"]).toBe(String(json(r).retryAfterSeconds));
      expect(sentCount(mem)).toBe(30);
      expect(await activities("emailed", mem)).toHaveLength(30);
      expect((await send(mem2, good())).statusCode).toBe(202);
      // reads are not limited
      expect((await threads(mem)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════ nothing is stored ═══════════════════════════════════════════════

  describe("nothing from the mailbox is stored or logged", () => {
    it("after sends, replies and reads, no table that could hold a copy and no log line contains a subject, a body or an address that went through", async () => {
      await connect(mem);
      await send(mem, good());
      await send(mem, good({ inReplyTo: { threadId: "t5", messageId: "m5c" } }));
      await send(mem, good({ context: { kind: "client", id: clientA } }));
      await threads(mem);
      await threads(mem, "?label=SENT");
      await thread(mem, "t5");
      for (const bad of [good({ to: ["nope"] }), good({ subject: "" })]) await send(mem, bad);
      await disconnect(mem);
      const needles = [SECRET_SUBJECT, SECRET_BODY, SECRET_ADDR, SECRET_CC].map((s) => `%${s}%`);
      for (const table of ["activities", "notifications", "outbox_events", "integration_connections", "google_oauth_states", "files", "comments"]) {
        for (const needle of needles) {
          const n = await count(`SELECT count(*)::int AS n FROM ${table} t WHERE to_jsonb(t)::text LIKE $1`, [needle]);
          expect(n, `${table} must hold none of what was sent (${needle})`).toBe(0);
        }
      }
      for (const line of logs) for (const s of [SECRET_SUBJECT, SECRET_BODY, SECRET_ADDR, SECRET_CC]) expect(line).not.toContain(s);
    });

    it("the whole suite made no network call (the Gmail HTTP seam would have thrown)", async () => {
      await connect(mem);
      await send(mem, good());
      await threads(mem);
      expect((await threads(mem)).statusCode).toBe(200);
    });
  });
});
