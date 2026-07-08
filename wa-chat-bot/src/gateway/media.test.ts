import { describe, it, expect, afterAll, vi } from "vitest";
import { config } from "../config";

vi.mock("./provider", () => ({
  complete: vi.fn(async () => "ok"),
  // A transcript that leaks a PAN — the route must DLP-scrub it before returning.
  describeMedia: vi.fn(async () => "caller said: pay to 4111 1111 1111 1111 today"),
}));

import { buildGatewayApp } from "./server";

describe("gateway /media", () => {
  config.gatewayToken = "test-token";
  const app = buildGatewayApp();
  const auth = { authorization: "Bearer test-token" };
  afterAll(() => app.close());

  it("rejects without a token (fail-closed)", async () => {
    const r = await app.inject({ method: "POST", url: "/media", payload: { base64: "aGk=", mime: "audio/ogg" } });
    expect(r.statusCode).toBe(401);
  });

  it("requires base64 and mime", async () => {
    const r = await app.inject({ method: "POST", url: "/media", headers: auth, payload: { mime: "audio/ogg" } });
    expect(r.statusCode).toBe(400);
  });

  it("returns extracted text with sensitive identifiers scrubbed (DLP)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/media",
      headers: auth,
      payload: { base64: "aGk=", mime: "audio/ogg" },
    });
    expect(r.statusCode).toBe(200);
    const { text } = r.json() as { text: string };
    expect(text).toContain("[REDACTED-CARD]");
    expect(text).not.toContain("4111");
  });
});
