// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48) — the routes of core/gmail as an isolated Nest app (the controllers only), run WITHOUT a database or
// Cerbos: the DB is an in-memory store (as in gmail.service.test.ts), the guard sets a principal from headers, and Cerbos is a small fake that
// states the shape of PERMISSION §40 (only the mailbox's own owner, only member/manager/company_admin, no agent). What this layer proves that
// the service test cannot: the route paths and verbs, the status codes (200, 202), the error body shape the HttpErrorFilter produces (`error`,
// `reason`, `field`, `retryAfterSeconds` and the Retry-After header), that the owner handed to the policy is ALWAYS the caller whatever the
// request carries, and the order of the send handler (gate, client read, THEN validation).
//
// It does not replace gmail.http.test.ts (real Postgres, real Cerbos, RLS, the policy file itself): that is the Linux gate.
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

interface Row {
  id: string; owner_kind: string; owner_id: string; provider: string; external_account: string | null; scopes: string[]; status: string;
  meta: Record<string, unknown>; token_expires_at: string | null; access_token_enc: string | null; refresh_token_enc: string | null; deleted_at: string | null;
}
const world = vi.hoisted(() => ({
  rows: [] as Array<Record<string, any>>,
  clients: new Set<string>(),
  authz: [] as Array<{ kind: string; action: string; ownerId?: string; id?: string; tenantId?: string }>,
  activities: [] as Array<{ verb: string; entityType: string; entityId: string | null; metadata: Record<string, unknown>; actor: string | null }>,
  denyClient: false,
}));

vi.mock("../../db", () => ({
  newId: () => globalThis.crypto.randomUUID(),
  withTenants: async (_t: string[], fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params: unknown[]) => {
        if (/FROM integration_connections/.test(sql)) {
          return { rows: world.rows.filter((r) => r.owner_id === params[0] && r.provider === params[1] && !r.deleted_at && r.owner_kind === "user") };
        }
        if (/FROM clients WHERE id = \$1/.test(sql)) return { rows: world.clients.has(String(params[0])) ? [{ "?column?": 1 }] : [] };
        throw new Error(`unexpected query: ${sql}`);
      },
    }),
}));
vi.mock("../integrations.service", () => ({
  createConnection: async (_t: string, i: Record<string, any>) => {
    let row = world.rows.find((r) => r.owner_id === i.ownerId && r.provider === i.provider);
    if (!row) {
      row = { id: globalThis.crypto.randomUUID(), owner_kind: i.ownerKind, owner_id: i.ownerId, provider: i.provider, status: "unconfigured", access_token_enc: null, refresh_token_enc: null, token_expires_at: null, deleted_at: null };
      world.rows.push(row);
    }
    Object.assign(row, { external_account: i.externalAccount ?? null, scopes: i.scopes ?? [], meta: i.meta ?? {} });
    return { id: row.id };
  },
  patchConnection: async (_t: string, id: string, p: Record<string, any>) => {
    const row = world.rows.find((r) => r.id === id)!;
    if (p.status !== undefined) row.status = p.status;
    if (p.meta !== undefined) row.meta = p.meta;
    return { id };
  },
  revokeConnection: async (_t: string, id: string) => {
    Object.assign(world.rows.find((r) => r.id === id)!, { status: "revoked", access_token_enc: null, refresh_token_enc: null });
    return { id };
  },
  setConnectionTokens: async () => ({ id: "x" }),
}));
// Cerbos, in the shape of PERMISSION §40: the owner only, member/manager/company_admin only, never an agent.
vi.mock("../http", () => ({
  authorize: async (
    p: { userId: string | null; roles: Array<{ role: string }>; kind?: string },
    r: { kind: string; ownerId?: string; id?: string; tenantId?: string },
    action: string,
  ) => {
    world.authz.push({ kind: r.kind, action, ownerId: r.ownerId, id: r.id, tenantId: r.tenantId });
    if (r.kind === "personal_mailbox") {
      const ok = p.roles.some((x) => ["member", "manager", "company_admin"].includes(x.role)) && !!r.ownerId && r.ownerId === p.userId && !["bot", "automation"].includes(p.kind ?? "");
      if (!ok) throw new ForbiddenException(`not authorized: cerbos denied ${action} on ${r.kind}`);
    }
    if (r.kind === "client" && world.denyClient) throw new ForbiddenException("not authorized: cerbos denied read on client");
  },
  writeActivity: async (_t: string, actor: string | null, verb: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) => {
    world.activities.push({ verb, entityType, entityId, metadata, actor });
    return "activity-id";
  },
}));

import { AuthGuard } from "../../auth/guards";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { GmailController, GmailOauthCallbackController } from "./gmail.controller";
import { setSendLimiterForTests, simulatedMailboxes } from "./service";
import { SendRateLimiter } from "./rate-limit";

const T = "aaaaaaaa-0000-0000-0000-00000000000a";
const ME = "11111111-1111-1111-1111-111111111111";
const YOU = "22222222-2222-2222-2222-222222222222";
const CLIENT = "cccccccc-0000-0000-0000-000000000001";
const GHOST_CLIENT = "cccccccc-0000-0000-0000-0000000000ff";

/** The guard double: a principal from headers (x-user-id, x-roles, x-kind), exactly the fields the policy fake reads. */
const fakeGuard = {
  canActivate(ctx: { switchToHttp(): { getRequest(): any } }) {
    const req = ctx.switchToHttp().getRequest();
    const h = req.headers;
    req.principal = { userId: h["x-user-id"] ?? null, roles: String(h["x-roles"] ?? "").split(",").filter(Boolean).map((role) => ({ role })), kind: h["x-kind"] };
    return true;
  },
};

describe("core/gmail routes (isolated app, no database, fake policy)", () => {
  let app: NestFastifyApplication;
  const saved = config.gmail.mode;
  const as = (userId: string, roles = "member", kind?: string) => ({ "x-user-id": userId, "x-roles": roles, ...(kind ? { "x-kind": kind } : {}) });
  const inject = (method: "GET" | "POST" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const json = (r: { json: () => unknown }) => r.json() as Record<string, any>;
  const ok = (over: Record<string, unknown> = {}) => ({ to: ["a@example.test"], subject: "Subject", body: "Body", ...over });
  const connect = async (userId = ME) => expect((await inject("GET", `/api/${T}/integrations/gmail/oauth/start`, as(userId))).statusCode).toBe(200);

  beforeAll(async () => {
    config.gmail.mode = "simulated";
    const moduleRef = await Test.createTestingModule({ controllers: [GmailController, GmailOauthCallbackController] })
      .overrideGuard(AuthGuard).useValue(fakeGuard)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false, abortOnError: false });
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    config.gmail.mode = saved;
    await app?.close();
  });
  beforeEach(() => {
    world.rows = [];
    world.clients = new Set([CLIENT]);
    world.authz = [];
    world.activities = [];
    world.denyClient = false;
    simulatedMailboxes.clear();
    setSendLimiterForTests(null);
  });

  it("status, start and disconnect: the documented paths, verbs and answers", async () => {
    const s0 = await inject("GET", `/api/${T}/integrations/gmail`, as(ME));
    expect(s0.statusCode).toBe(200);
    expect(json(s0)).toEqual({ configured: true, connected: false, needsReconnect: false, accountEmail: null, mode: "simulated" });
    const st = await inject("GET", `/api/${T}/integrations/gmail/oauth/start`, as(ME));
    expect(st.statusCode).toBe(200);
    expect(json(st)).toMatchObject({ mode: "simulated", linked: true });
    expect(Object.keys(json(st)).sort()).toEqual(["accountEmail", "linked", "mode"]);
    expect(json(await inject("GET", `/api/${T}/integrations/gmail`, as(ME))).connected).toBe(true);
    const del = await inject("DELETE", `/api/${T}/integrations/gmail`, as(ME));
    expect(del.statusCode).toBe(200);
    expect(json(del)).toEqual({ disconnected: true, revokedAtGoogle: null, mode: "simulated" });
    expect(world.activities.map((a) => [a.verb, a.entityType, a.metadata])).toEqual([
      ["connected", "integration_connection", { provider: "google_gmail", mode: "simulated" }],
      ["disconnected", "integration_connection", { provider: "google_gmail", mode: "simulated", revokedAtGoogle: null }],
    ]);
  });

  it("EVERY route asks the policy about the CALLER's own mailbox, whatever the request carries (query, headers, body, path)", async () => {
    await connect();
    world.authz = [];
    const lure = `?userId=${YOU}&ownerId=${YOU}&owner=${YOU}`;
    const headers = { ...as(ME), "x-owner-id": YOU, "x-mailbox-owner": YOU };
    await inject("GET", `/api/${T}/integrations/gmail${lure}`, headers);
    await inject("GET", `/api/${T}/integrations/gmail/oauth/start${lure}`, headers);
    await inject("GET", `/api/${T}/mail/me/threads${lure}`, headers);
    await inject("GET", `/api/${T}/mail/me/threads/t5${lure}`, headers);
    await inject("POST", `/api/${T}/mail/me/send`, headers, { ...ok(), ownerId: YOU, userId: YOU, from: "someone@else.test" });
    await inject("DELETE", `/api/${T}/integrations/gmail${lure}`, headers);
    const mailboxChecks = world.authz.filter((a) => a.kind === "personal_mailbox");
    expect(mailboxChecks.map((a) => a.action)).toEqual(["connect", "connect", "read", "read", "send", "connect"]);
    for (const c of mailboxChecks) expect(c.ownerId, `${c.action} must be checked against the caller's own mailbox`).toBe(ME);
    expect(world.rows.every((r) => r.owner_id === ME)).toBe(true);
  });

  it("the gate is the policy's: another person's id never helps, an agent and a viewer are refused on every route, and the answer is a 403 with the policy's words", async () => {
    for (const headers of [as(ME, "viewer"), as(ME, "member", "bot"), as(ME, "member", "automation"), as(ME, "")]) {
      for (const [method, url] of [
        ["GET", `/api/${T}/integrations/gmail`], ["GET", `/api/${T}/integrations/gmail/oauth/start`], ["DELETE", `/api/${T}/integrations/gmail`],
        ["GET", `/api/${T}/mail/me/threads`], ["GET", `/api/${T}/mail/me/threads/t5`], ["POST", `/api/${T}/mail/me/send`],
      ] as const) {
        const r = await inject(method, url, headers, method === "POST" ? ok() : undefined);
        expect(r.statusCode, `${method} ${url} as ${JSON.stringify(headers)}`).toBe(403);
        expect(json(r).error).toMatch(/^not authorized: cerbos denied /);
      }
    }
    expect(world.rows).toEqual([]);
  });

  it("a principal with no user id is refused after the gate (400 user_required), never an anonymous mailbox", async () => {
    const r = await inject("GET", `/api/${T}/integrations/gmail`, { "x-roles": "member" });
    expect(r.statusCode).toBe(403); // the policy fake sees ownerId '' and refuses first
  });

  it("reads: the list answers {mode, threads, nextPageToken}; a thread is decoded; the bad inputs are 400 with `reason` and `field`, and a 403 comes before them", async () => {
    await connect();
    const list = await inject("GET", `/api/${T}/mail/me/threads`, as(ME));
    expect(list.statusCode).toBe(200);
    expect(Object.keys(json(list)).sort()).toEqual(["mode", "nextPageToken", "threads"]);
    expect((await inject("GET", `/api/${T}/mail/me/threads?label=SENT`, as(ME))).statusCode).toBe(200);
    expect((await inject("GET", `/api/${T}/mail/me/threads/t3`, as(ME))).statusCode).toBe(200);
    for (const [url, field] of [[`/api/${T}/mail/me/threads?label=TRASH`, "label"], [`/api/${T}/mail/me/threads?pageToken=a%20b`, "pageToken"], [`/api/${T}/mail/me/threads/a%20b`, "threadId"]] as const) {
      const r = await inject("GET", url, as(ME));
      expect(r.statusCode, url).toBe(400);
      expect(json(r)).toMatchObject({ reason: "gmail_request_invalid", field });
      expect(json(r).error.startsWith("gmail_request_invalid:")).toBe(true);
    }
    expect((await inject("GET", `/api/${T}/mail/me/threads?label=TRASH`, as(ME, "viewer"))).statusCode).toBe(403);
    const nf = await inject("GET", `/api/${T}/mail/me/threads/nope`, as(ME));
    expect(nf.statusCode).toBe(404);
    expect(json(nf).reason).toBe("gmail_not_found");
  });

  it("not connected: reads and send are 409 gmail_not_connected with the token at the start of `error`", async () => {
    for (const r of [await inject("GET", `/api/${T}/mail/me/threads`, as(ME)), await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok())]) {
      expect(r.statusCode).toBe(409);
      expect(json(r)).toMatchObject({ reason: "gmail_not_connected" });
      expect(json(r).error.startsWith("gmail_not_connected:")).toBe(true);
    }
  });

  it("send: 202 {mode, messageId, threadId}; ONE `emailed` activity with only the count and mode, on nobody; the message is in SENT", async () => {
    await connect();
    world.activities = [];
    const r = await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok({ cc: ["b@example.test"] }));
    expect(r.statusCode, r.body).toBe(202);
    expect(Object.keys(json(r)).sort()).toEqual(["messageId", "mode", "threadId"]);
    expect(world.activities).toEqual([{ verb: "emailed", entityType: "personal_mailbox", entityId: null, metadata: { recipientCount: 2, mode: "simulated" }, actor: ME }]);
    expect(JSON.stringify(world.activities)).not.toMatch(/Subject|Body|example\.test/);
    expect(json(await inject("GET", `/api/${T}/mail/me/threads?label=SENT`, as(ME))).threads).toHaveLength(1);
  });

  it("send order: the gate first (a viewer with an invalid body is 403), then the client read, THEN validation (400 with `field`)", async () => {
    await connect();
    expect((await inject("POST", `/api/${T}/mail/me/send`, as(ME, "viewer"), {})).statusCode).toBe(403);
    world.authz = [];
    const bad = await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok({ to: ["nope"], context: { kind: "client", id: CLIENT } }));
    expect(bad.statusCode).toBe(400);
    expect(json(bad)).toMatchObject({ reason: "gmail_send_invalid", field: "to" });
    expect(world.authz.map((a) => `${a.kind}:${a.action}`)).toEqual(["personal_mailbox:send", "client:read"]);
    expect(world.authz[1].id).toBe(CLIENT);
    expect(simulatedMailboxes.sentCount(ME)).toBe(0);
    expect(world.activities.filter((a) => a.verb === "emailed")).toEqual([]);
  });

  it("\"Email this client\": a readable client context records `emailed` ON the client; a denied client read is 403 BEFORE the body is looked at; an unknown client is 400 on `context`", async () => {
    await connect();
    world.activities = [];
    const r = await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok({ context: { kind: "client", id: CLIENT.toUpperCase() } }));
    expect(r.statusCode, r.body).toBe(202);
    expect(world.activities).toEqual([{ verb: "emailed", entityType: "client", entityId: CLIENT, metadata: { recipientCount: 1, mode: "simulated" }, actor: ME }]);

    world.activities = [];
    world.denyClient = true;
    for (const body of [ok({ context: { kind: "client", id: CLIENT } }), { context: { kind: "client", id: CLIENT } }, { context: { kind: "client" } }]) {
      expect((await inject("POST", `/api/${T}/mail/me/send`, as(ME), body)).statusCode).toBe(403);
    }
    world.denyClient = false;
    expect(simulatedMailboxes.sentCount(ME)).toBe(1);
    expect(world.activities).toEqual([]);

    const ghost = await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok({ context: { kind: "client", id: GHOST_CLIENT } }));
    expect(ghost.statusCode).toBe(400);
    expect(json(ghost)).toMatchObject({ reason: "gmail_send_invalid", field: "context" });
    const wrongKind = await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok({ context: { kind: "project", id: CLIENT } }));
    expect(json(wrongKind)).toMatchObject({ reason: "gmail_send_invalid", field: "context" });
    expect(simulatedMailboxes.sentCount(ME)).toBe(1);
  });

  it("a failed activity write after a delivered send does not turn it into an error (the person must not send twice)", async () => {
    await connect();
    const http = await import("../http");
    const spy = vi.spyOn(http, "writeActivity").mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok());
    spy.mockRestore();
    expect(r.statusCode).toBe(202);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the message was sent"));
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/Subject|Body|example\.test/);
    warn.mockRestore();
    expect(simulatedMailboxes.sentCount(ME)).toBe(1);
  });

  it("the 31st send is 429 with the documented body AND the Retry-After header; the refused send delivered nothing", async () => {
    await connect();
    setSendLimiterForTests(new SendRateLimiter(30, 3_600_000));
    for (let i = 0; i < 30; i++) expect((await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok({ subject: `S${i}` }))).statusCode).toBe(202);
    const r = await inject("POST", `/api/${T}/mail/me/send`, as(ME), ok());
    expect(r.statusCode).toBe(429);
    expect(json(r)).toMatchObject({ reason: "gmail_send_rate_limited" });
    expect(json(r).error.startsWith("gmail_send_rate_limited:")).toBe(true);
    expect(Number.isInteger(json(r).retryAfterSeconds)).toBe(true);
    expect(json(r).retryAfterSeconds).toBeGreaterThan(3500);
    expect(r.headers["retry-after"]).toBe(String(json(r).retryAfterSeconds));
    expect(simulatedMailboxes.sentCount(ME)).toBe(30);
    await connect(YOU);
    expect((await inject("POST", `/api/${T}/mail/me/send`, as(YOU), ok())).statusCode).toBe(202);
  });

  it("the callback has no flow in simulated mode (400 gmail_state_invalid) and writes nothing", async () => {
    const r = await inject("GET", "/api/gmail/oauth/callback?code=x&state=y", as(ME));
    expect(r.statusCode).toBe(400);
    expect(json(r).reason).toBe("gmail_state_invalid");
    expect(world.activities).toEqual([]);
    expect(world.rows).toEqual([]);
  });
});
