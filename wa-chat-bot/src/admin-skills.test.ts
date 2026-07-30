// GET /admin/skills (1c): auth (401/503) + the read-only catalog shape from listSkills().
// ./store is mocked (same convention as skills.test.ts) so this never depends on a live DB.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildApp } from "./server";
import { config } from "./config";

vi.mock("./store", () => ({
  initStore: vi.fn(async () => undefined),
  saveMessage: vi.fn(async () => undefined),
  getMessages: vi.fn(async () => []),
  getGroupChatIds: vi.fn(async () => []),
  getPendingMedia: vi.fn(async () => []),
  updateMedia: vi.fn(async () => undefined),
  listChats: vi.fn(async () => []),
  getMessagesPage: vi.fn(async () => []),
  searchMessages: vi.fn(async () => []),
}));

const gw = { sendText: async () => {} };

describe("GET /admin/skills", () => {
  beforeEach(() => {
    config.adminToken = "sekret";
  });

  it("401s without the admin token", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/skills" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("503s when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/skills", headers: { authorization: "Bearer whatever" } });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("returns commandPrefix, botMention, and the registered skills (name + description only)", async () => {
    config.commandPrefix = "/";
    config.botMention = "@rhea";
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/skills", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commandPrefix: string; botMention: string; skills: Array<{ name: string; description: string }> };
    expect(body.commandPrefix).toBe("/");
    expect(body.botMention).toBe("@rhea");
    const names = body.skills.map((s) => s.name);
    for (const n of ["ping", "help", "summarize", "capture", "captures", "actions"]) {
      expect(names).toContain(n);
    }
    // Read-only catalog: no handler function or other internal field leaks into the response.
    for (const s of body.skills) {
      expect(Object.keys(s).sort()).toEqual(["description", "name"]);
    }
    await app.close();
  });
});
