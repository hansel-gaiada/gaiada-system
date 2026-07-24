// A4: bot-admin proxy (src/admin/bot-admin.controller.ts) + the admin-systems.controller.ts
// bot-session/bot-config additions it depends on. Same pattern as admin-systems.test.ts: a tiny
// stub HTTP server standing in for the bot's own ADMIN_TOKEN-gated /admin/* surface, real
// PG + Cerbos for authz. Needs live PG + Cerbos (buildApp + authorize) like the other suites.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const BOT_TOKEN = "bot-admin-token";

type BotConfigField = { key: string; value: unknown; editable: boolean; type: "text" | "bool" | "number" };

/** Stub for the bot's own /admin/* surface (A1/A2) + /health, at the bot's real (unprefixed)
 *  paths — config.services.bot.url points straight at this server's root. */
function startBotStub(): Promise<{ server: Server; base: string }> {
  let groups: Array<{ id: string; name?: string; category?: string; optIn?: boolean; isManagement?: boolean }> = [
    { id: "111@g.us", name: "Ops", category: "ops", optIn: true, isManagement: false },
  ];
  let postToGroups = true;
  let managementGroupId = "111@g.us";
  const configFields = (): { fields: BotConfigField[] } => ({
    fields: [
      { key: "wahaSession", value: "default", editable: false, type: "text" },
      { key: "botName", value: "Gaiada Bot", editable: false, type: "text" },
      { key: "postToGroups", value: postToGroups, editable: true, type: "bool" },
      { key: "managementGroupId", value: managementGroupId, editable: true, type: "text" },
      { key: "monitoredCount", value: groups.length, editable: false, type: "number" },
    ],
  });

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // /health is the bot's public liveness route (no ADMIN_TOKEN gate, matching wa-chat-bot's
    // real server.ts); every /admin/* route below IS gated.
    if (req.url === "/health") return send(200, { ok: true, ai: "on", session: "WORKING" });
    if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return send(401, { error: "unauthorized" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = bodyText ? JSON.parse(bodyText) : undefined;
      } catch {
        body = undefined;
      }
      const url = req.url ?? "";
      const m = req.method ?? "GET";

      if (m === "POST" && url === "/admin/session/start") return send(200, { session: "default", status: "SCAN_QR_CODE", engine: "NOWEB" });
      if (m === "GET" && url === "/admin/session/status") {
        return send(200, { session: "default", status: "WORKING", engine: "NOWEB", me: { id: "628@c.us", pushName: "Bot" }, lastEvent: { status: "WORKING", ts: 123 } });
      }
      if (m === "GET" && url === "/admin/session/qr") return send(200, { qr: "data:image/png;base64,AAAA", status: "SCAN_QR_CODE" });
      if (m === "POST" && url === "/admin/session/stop") return send(200, { session: "default", status: "STOPPED" });
      if (m === "POST" && url === "/admin/session/logout") return send(200, { session: "default", status: "STOPPED" });
      if (m === "POST" && url === "/admin/session/restart") return send(200, { session: "default", status: "STARTING" });

      if (m === "GET" && url === "/admin/groups") return send(200, { registryActive: true, groups, discovered: [], managementGroupId });
      if (m === "PUT" && url === "/admin/groups") {
        const g = ((body as { groups?: Array<{ id?: string }> })?.groups ?? []) as Array<{ id?: string }>;
        const bad = g.find((x) => !/^\d+@g\.us$/.test(String(x.id)));
        if (bad) return send(400, { error: "invalid group id", field: "groups" });
        groups = g as typeof groups;
        return send(200, { registryActive: true, groups, discovered: [], managementGroupId });
      }

      if (m === "GET" && url === "/admin/config") return send(200, configFields());
      if (m === "PUT" && url === "/admin/config") {
        const b = (body ?? {}) as { postToGroups?: unknown; managementGroupId?: unknown };
        if ("postToGroups" in b) {
          if (typeof b.postToGroups !== "boolean") return send(400, { error: "postToGroups must be a boolean", field: "postToGroups" });
          postToGroups = b.postToGroups;
        }
        if ("managementGroupId" in b) {
          if (typeof b.managementGroupId !== "string") return send(400, { error: "managementGroupId must be a string", field: "managementGroupId" });
          managementGroupId = b.managementGroupId;
        }
        return send(200, configFields());
      }

      // Chat viewer + logs (design doc addendum).
      if (m === "GET" && url?.startsWith("/admin/chats/999%40g.us/messages")) {
        return send(404, { error: "unknown chat (no stored messages)" });
      }
      if (m === "GET" && url?.startsWith("/admin/chats/") && url.endsWith("/messages")) {
        const encoded = url.slice("/admin/chats/".length, url.indexOf("/messages"));
        const chatId = decodeURIComponent(encoded);
        const u = new URL(`http://x${url}`);
        const limit = u.searchParams.get("limit");
        return send(200, {
          chatId,
          messages: [
            { ts: 1000, senderId: "s1", senderName: "Siti", text: "first", fromBot: false },
            { ts: 2000, senderId: "s1", senderName: "Siti", text: "second", fromBot: false },
          ],
          receivedLimit: limit,
        });
      }
      if (m === "GET" && url?.startsWith("/admin/chats")) {
        const u = new URL(`http://x${url}`);
        const limit = u.searchParams.get("limit");
        return send(200, {
          chats: [
            { chatId: "111@g.us", kind: "group", surface: "whatsapp", name: "Ops", messageCount: 3, lastActivityTs: 2000, lastPreview: "hi" },
          ],
          receivedLimit: limit,
        });
      }
      if (m === "GET" && url === "/admin/session/events") {
        return send(200, { events: [{ status: "STARTING", ts: 1 }, { status: "WORKING", ts: 2 }] });
      }
      if (m === "GET" && url?.startsWith("/admin/actions/audit")) {
        const u = new URL(`http://x${url}`);
        const limit = u.searchParams.get("limit");
        return send(200, { enabled: true, entries: [], receivedLimit: limit });
      }

      return send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe.skipIf(!TEST_URL)("bot admin proxy (A4)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let stubBase: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    const { server, base } = await startBotStub();
    stub = server;
    stubBase = base;
    config.services.bot = { url: base, token: BOT_TOKEN };

    const tenantA = await createCompany("Agency A", ["agency"]);
    admin = await createUser("botadmin@a.test");
    member = await createUser("botmember@a.test");
    await addMembership(tenantA, admin);
    await addMembership(tenantA, member);
    const adminRole = await createRole("platform_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, adminRole, "global", null);
    await grantRole(member, memberRole, "company", tenantA);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => stub.close(() => r()));
    await teardownTestDb();
  });

  it("proxies every session route", async () => {
    const start = await app.inject({ method: "POST", url: "/api/admin/bot/session/start", headers: asUser(admin) });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ session: "default", status: "SCAN_QR_CODE", engine: "NOWEB" });

    const status = await app.inject({ method: "GET", url: "/api/admin/bot/session/status", headers: asUser(admin) });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: "WORKING", me: { id: "628@c.us" } });

    const stop = await app.inject({ method: "POST", url: "/api/admin/bot/session/stop", headers: asUser(admin) });
    expect(stop.json()).toMatchObject({ status: "STOPPED" });

    const logout = await app.inject({ method: "POST", url: "/api/admin/bot/session/logout", headers: asUser(admin) });
    expect(logout.json()).toMatchObject({ status: "STOPPED" });

    const restart = await app.inject({ method: "POST", url: "/api/admin/bot/session/restart", headers: asUser(admin) });
    expect(restart.json()).toMatchObject({ status: "STARTING" });
  });

  it("QR is passed through with a no-store header, never fabricated", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/bot/session/qr", headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json()).toEqual({ qr: "data:image/png;base64,AAAA", status: "SCAN_QR_CODE" });
  });

  it("groups: get + full-replace put, both directions of validation", async () => {
    const get = await app.inject({ method: "GET", url: "/api/admin/bot/groups", headers: asUser(admin) });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ registryActive: true, managementGroupId: "111@g.us" });

    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/bot/groups",
      headers: asUser(admin),
      payload: { groups: [{ id: "222@g.us", name: "Sales", category: "sales", optIn: true, isManagement: false }] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ groups: [{ id: "222@g.us" }] });

    // Nest-level top-level shape check (never reaches the bot).
    const badShape = await app.inject({ method: "PUT", url: "/api/admin/bot/groups", headers: asUser(admin), payload: { groups: "nope" } });
    expect(badShape.statusCode).toBe(400);
    expect(badShape.json()).toMatchObject({ error: expect.any(String), field: "groups" });

    // Bot's own field-level validation, surfaced verbatim.
    const badId = await app.inject({
      method: "PUT",
      url: "/api/admin/bot/groups",
      headers: asUser(admin),
      payload: { groups: [{ id: "not-a-group-id" }] },
    });
    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({ error: "invalid group id", field: "groups" });

    // restore for later tests
    await app.inject({
      method: "PUT",
      url: "/api/admin/bot/groups",
      headers: asUser(admin),
      payload: { groups: [{ id: "111@g.us", name: "Ops", category: "ops", optIn: true, isManagement: false }] },
    });
  });

  it("config PUT: nest-level key allow-list, then the bot's own value-type validation, then success", async () => {
    const disallowed = await app.inject({ method: "PUT", url: "/api/admin/bot/config", headers: asUser(admin), payload: { key: "wahaSession", value: "x" } });
    expect(disallowed.statusCode).toBe(400);
    expect(disallowed.json()).toMatchObject({ error: expect.any(String), field: "key" });

    const badValue = await app.inject({ method: "PUT", url: "/api/admin/bot/config", headers: asUser(admin), payload: { key: "postToGroups", value: "not-a-bool" } });
    expect(badValue.statusCode).toBe(400);
    expect(badValue.json()).toMatchObject({ error: expect.any(String), field: "postToGroups" });

    const ok = await app.inject({ method: "PUT", url: "/api/admin/bot/config", headers: asUser(admin), payload: { key: "postToGroups", value: false } });
    expect(ok.statusCode).toBe(200);
    const fields = (ok.json() as { fields: BotConfigField[] }).fields;
    expect(fields.find((f) => f.key === "postToGroups")?.value).toBe(false);

    // restore
    await app.inject({ method: "PUT", url: "/api/admin/bot/config", headers: asUser(admin), payload: { key: "postToGroups", value: true } });
  });

  it("chats: list + thread proxies pass the limit querystring and preserve chatId encoding", async () => {
    const list = await app.inject({ method: "GET", url: "/api/admin/bot/chats?limit=7", headers: asUser(admin) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      chats: [{ chatId: "111@g.us", kind: "group", surface: "whatsapp" }],
      receivedLimit: "7",
    });

    const thread = await app.inject({
      method: "GET",
      url: "/api/admin/bot/chats/111%40g.us/messages?limit=2",
      headers: asUser(admin),
    });
    expect(thread.statusCode).toBe(200);
    const threadBody = thread.json() as { chatId: string; messages: Array<{ text: string }>; receivedLimit: string };
    expect(threadBody.chatId).toBe("111@g.us");
    expect(threadBody.messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(threadBody.receivedLimit).toBe("2");

    // 404 from the bot (no stored messages) is surfaced verbatim.
    const notFound = await app.inject({ method: "GET", url: "/api/admin/bot/chats/999%40g.us/messages", headers: asUser(admin) });
    expect(notFound.statusCode).toBe(404);

    // tg: chat ids round-trip through URL-encoding correctly.
    const tg = await app.inject({ method: "GET", url: `/api/admin/bot/chats/${encodeURIComponent("tg:-1001")}/messages`, headers: asUser(admin) });
    expect(tg.statusCode).toBe(200);
  });

  it("session/events proxies the transitions ring buffer", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/bot/session/events", headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ events: [{ status: "STARTING", ts: 1 }, { status: "WORKING", ts: 2 }] });
  });

  it("actions/audit proxies the bot's existing audit log for the Logs tab", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/bot/actions/audit?limit=50", headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ enabled: true, entries: [], receivedLimit: "50" });
  });

  it("bot admin proxy is fail-soft for the new chat-viewer routes too (unreachable -> 502)", async () => {
    config.services.bot = { url: "http://127.0.0.1:9/bad", token: BOT_TOKEN };
    const r = await app.inject({ method: "GET", url: "/api/admin/bot/chats", headers: asUser(admin) });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: expect.stringContaining("unreachable") });
    config.services.bot = { url: stubBase, token: BOT_TOKEN };
  });

  it("non-elevated user is 403 on every bot admin route", async () => {
    const routes: Array<{ method: "GET" | "POST" | "PUT"; url: string }> = [
      { method: "POST", url: "/api/admin/bot/session/start" },
      { method: "GET", url: "/api/admin/bot/session/status" },
      { method: "GET", url: "/api/admin/bot/session/qr" },
      { method: "POST", url: "/api/admin/bot/session/stop" },
      { method: "POST", url: "/api/admin/bot/session/logout" },
      { method: "POST", url: "/api/admin/bot/session/restart" },
      { method: "GET", url: "/api/admin/bot/groups" },
      { method: "PUT", url: "/api/admin/bot/groups" },
      { method: "PUT", url: "/api/admin/bot/config" },
      { method: "GET", url: "/api/admin/bot/chats" },
      { method: "GET", url: "/api/admin/bot/chats/111%40g.us/messages" },
      { method: "GET", url: "/api/admin/bot/session/events" },
      { method: "GET", url: "/api/admin/bot/actions/audit" },
    ];
    for (const r of routes) {
      const res = await app.inject({ method: r.method, url: r.url, headers: asUser(member), payload: r.method === "PUT" ? { groups: [] } : undefined });
      expect(res.statusCode).toBe(403);
    }
  });

  it("bot not configured -> 404; bot unreachable -> 502 (fail-soft, never fabricated)", async () => {
    config.services.bot = { url: "", token: "" };
    const notConfigured = await app.inject({ method: "GET", url: "/api/admin/bot/session/status", headers: asUser(admin) });
    expect(notConfigured.statusCode).toBe(404);
    expect(notConfigured.json()).toMatchObject({ error: expect.stringContaining("not configured") });

    config.services.bot = { url: "http://127.0.0.1:9/bad", token: BOT_TOKEN };
    const unreachable = await app.inject({ method: "GET", url: "/api/admin/bot/session/status", headers: asUser(admin) });
    expect(unreachable.statusCode).toBe(502);
    expect(unreachable.json()).toMatchObject({ error: expect.stringContaining("unreachable") });

    config.services.bot = { url: stubBase, token: BOT_TOKEN };
  });

  it("admin-systems: bot status gains detail.session; bot config proxies bot fields as editable", async () => {
    const status = await app.inject({ method: "GET", url: "/api/admin/bot/status", headers: asUser(admin) });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ ok: true, detail: { ai: "on", session: "WORKING" } });

    // Same path, GET method -> resolves to the generic admin-systems :system/config route
    // (bot-admin.controller.ts deliberately has no GET config route), now proxying the bot.
    const cfg = await app.inject({ method: "GET", url: "/api/admin/bot/config", headers: asUser(admin) });
    expect(cfg.statusCode).toBe(200);
    const fields = (cfg.json() as { fields: Array<{ key: string; kind: string; editable: boolean }> }).fields;
    const postToGroups = fields.find((f) => f.key === "postToGroups")!;
    const managementGroupId = fields.find((f) => f.key === "managementGroupId")!;
    expect(postToGroups).toMatchObject({ kind: "boolean", editable: true });
    expect(managementGroupId).toMatchObject({ kind: "text", editable: true });
    const wahaSession = fields.find((f) => f.key === "wahaSession")!;
    expect(wahaSession.editable).toBe(false);
  });
});
