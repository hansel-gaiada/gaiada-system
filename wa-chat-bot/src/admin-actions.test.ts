// Phase G: the runtime kill-switch + audit admin routes (incident response).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import { buildApp } from "./server";
import { config } from "./config";
import { actionsEnabled, setActionsEnabled } from "./safety/kill-switch";
import { recordActionAudit } from "./safety/audit";

const gw = { sendText: async () => {} };

describe("admin action routes", () => {
  beforeEach(() => {
    config.adminToken = "sekret";
    config.actionAuditFile = "data/admin-actions.test.jsonl";
    try { rmSync(config.actionAuditFile); } catch { /* ignore */ }
    setActionsEnabled(true);
  });
  afterAll(() => { try { rmSync("data/admin-actions.test.jsonl"); } catch { /* ignore */ } });

  it("rejects without the admin token", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "POST", url: "/admin/actions/off" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("flips the kill-switch off and back on", async () => {
    const app = buildApp(gw as any);
    const off = await app.inject({ method: "POST", url: "/admin/actions/off", headers: { authorization: "Bearer sekret" } });
    expect(off.json()).toEqual({ actionsEnabled: false });
    expect(actionsEnabled()).toBe(false);
    const on = await app.inject({ method: "POST", url: "/admin/actions/on", headers: { authorization: "Bearer sekret" } });
    expect(on.json()).toEqual({ actionsEnabled: true });
    await app.close();
  });

  it("rejects an invalid state", async () => {
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "POST", url: "/admin/actions/maybe", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("reads back the action audit", async () => {
    await recordActionAudit({
      ts: 1, surface: "whatsapp", chatId: "g@g.us", actor: "h", action: "task.create",
      argsSummary: "title=x", decision: "allow", outcome: "done",
    });
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/actions/audit", headers: { authorization: "Bearer sekret" } });
    const body = res.json() as { enabled: boolean; entries: Array<{ action: string }> };
    expect(body.entries.some((e) => e.action === "task.create")).toBe(true);
    await app.close();
  });
});
