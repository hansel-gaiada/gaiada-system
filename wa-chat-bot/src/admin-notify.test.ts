// POST /admin/notify (TR-11): auth (401/503), input validation (400), and the checkin-reminder
// compose+send round trip against a mocked hub. The real hub round trip (against a live
// platform-nest) is exercised by platform-nest's own checkins-mcp-obo.db.test.ts and by
// checkin.test.ts's composeCheckinReminder/tryCheckinReply unit tests; this file's job is only the
// HTTP surface: auth gating, validation, and that the route wires those two functions correctly.
import { describe, it, expect, beforeEach, vi } from "vitest";

const callHubTool = vi.fn(async (_t: string, _a: Record<string, unknown>, _e: unknown) => "{}");
vi.mock("./hub", async (importOriginal) => {
  const real = await importOriginal<typeof import("./hub")>();
  return {
    HubDeniedError: real.HubDeniedError,
    callHubTool: (t: string, a: Record<string, unknown>, e: unknown) => callHubTool(t, a, e),
  };
});

import { buildApp } from "./server";
import { config } from "./config";
import { HubDeniedError } from "./hub";
import { resetPendingCheckins, getPendingCheckin } from "./checkin-reminder";

describe("POST /admin/notify", () => {
  beforeEach(() => {
    config.adminToken = "sekret";
    config.hubServiceToken = "hub-token";
    callHubTool.mockReset();
    resetPendingCheckins();
  });

  it("401s without the admin token", async () => {
    const app = buildApp({ sendText: async () => {} } as any);
    const res = await app.inject({ method: "POST", url: "/admin/notify", payload: { tenantId: "t1", chatId: "628@c.us" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("503s when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp({ sendText: async () => {} } as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/notify",
      headers: { authorization: "Bearer whatever" },
      payload: { tenantId: "t1", chatId: "628@c.us" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("400s on a missing tenantId/chatId", async () => {
    const app = buildApp({ sendText: async () => {} } as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/notify",
      headers: { authorization: "Bearer sekret" },
      payload: { tenantId: "t1" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s on an invalid chatId shape", async () => {
    const app = buildApp({ sendText: async () => {} } as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/notify",
      headers: { authorization: "Bearer sekret" },
      payload: { tenantId: "t1", chatId: "not-a-chat-id" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("sends the composed reminder and stores pending state on success", async () => {
    callHubTool.mockResolvedValueOnce(
      JSON.stringify({ date: "2026-07-31", alreadySubmitted: false, draft: { summaryText: "Logged 2h." } }),
    );
    const sendText = vi.fn(async () => {});
    const app = buildApp({ sendText } as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/notify",
      headers: { authorization: "Bearer sekret" },
      payload: { tenantId: "t1", chatId: "628110@c.us" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true, chatId: "628110@c.us" });
    expect(sendText).toHaveBeenCalledWith("628110@c.us", expect.stringContaining("Logged 2h."));
    expect(getPendingCheckin("628110@c.us")?.tenantId).toBe("t1");
    await app.close();
  });

  it("already-submitted -> sent:false, nothing dispatched (idempotent re-drive)", async () => {
    callHubTool.mockResolvedValueOnce(
      JSON.stringify({ date: "2026-07-31", alreadySubmitted: true, draft: { summaryText: "x" } }),
    );
    const sendText = vi.fn(async () => {});
    const app = buildApp({ sendText } as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/notify",
      headers: { authorization: "Bearer sekret" },
      payload: { tenantId: "t1", chatId: "628110@c.us" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: false, reason: "already submitted" });
    expect(sendText).not.toHaveBeenCalled();
    await app.close();
  });

  it("a HubDeniedError surfaces as 403, not a 500", async () => {
    callHubTool.mockRejectedValueOnce(new HubDeniedError("no verified link"));
    const app = buildApp({ sendText: async () => {} } as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/notify",
      headers: { authorization: "Bearer sekret" },
      payload: { tenantId: "t1", chatId: "628110@c.us" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("503s when HUB_SERVICE_TOKEN is unset", async () => {
    config.hubServiceToken = "";
    const app = buildApp({ sendText: async () => {} } as any);
    const res = await app.inject({
      method: "POST",
      url: "/admin/notify",
      headers: { authorization: "Bearer sekret" },
      payload: { tenantId: "t1", chatId: "628110@c.us" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
