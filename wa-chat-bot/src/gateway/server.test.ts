import { describe, it, expect, afterAll } from "vitest";
import { buildGatewayApp } from "./server";

// No GATEWAY_TOKEN in the test env → /complete must be fail-closed.
describe("gateway (fail-closed)", () => {
  const app = buildGatewayApp();
  afterAll(() => app.close());

  it("GET /health is open", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
  });

  it("rejects /complete without a token", async () => {
    const r = await app.inject({ method: "POST", url: "/complete", payload: { prompt: "hi" } });
    expect(r.statusCode).toBe(401);
  });
});
