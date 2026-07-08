import { describe, it, expect, afterAll } from "vitest";
import { config } from "./config";
import { buildApp } from "./server";

// With WEBHOOK_SECRET / ADMIN_TOKEN unset, both protected routes must be closed.
// Forced here so a developer's real .env can't change what the test exercises.
describe("server security (fail-closed)", () => {
  config.webhookSecret = "";
  config.adminToken = "";
  config.telegramWebhookSecret = "";
  const app = buildApp();
  afterAll(() => app.close());

  it("GET /health is open", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
  });

  it("rejects an unauthenticated webhook", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/webhook",
      payload: { event: "message", payload: { from: "1@c.us", body: "hi" } },
    });
    expect(r.statusCode).toBe(401);
  });

  it("disables the admin digest route when no ADMIN_TOKEN is set", async () => {
    const r = await app.inject({ method: "POST", url: "/digest/123@g.us" });
    expect(r.statusCode).toBe(503);
  });

  it("rejects telegram updates when no TELEGRAM_WEBHOOK_SECRET is set (fail-closed)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/telegram-webhook",
      headers: { "x-telegram-bot-api-secret-token": "anything" },
      payload: { message: { text: "hi", chat: { id: 1, type: "private" }, from: { id: 1 } } },
    });
    expect(r.statusCode).toBe(401);
  });
});
