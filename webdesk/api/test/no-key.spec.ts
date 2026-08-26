// WSK-05 — the no-key probe: missing, empty, malformed, and syntactically-plausible-but-unknown
// credentials all refuse, and never with a 500 (fail closed means a clean refusal, not a crash
// that happens to also deny access).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { startTestApp, stopTestApp } from "./helpers/app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";

describe("WSK-05 no-key probe", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;

  beforeAll(async () => {
    app = await startTestApp();
    tenant = await createFixtureTenant("nokey");
  });

  afterAll(async () => {
    await stopTestApp(app);
  });

  it("no Authorization header at all -> 401", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/t/${tenant.slug}/content` });
    expect(res.statusCode).toBe(401);
  });

  it("empty Authorization header -> 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenant.slug}/content`,
      headers: { authorization: "" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("malformed scheme (not Bearer) -> 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenant.slug}/content`,
      headers: { authorization: "Basic dGVzdDp0ZXN0" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("well-formed but entirely unknown key -> 401, not 500", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/${tenant.slug}/content`,
      headers: { authorization: "Bearer wdsk_this-key-was-never-minted-by-anyone" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("unknown tenant slug -> 401 (same shape as an unknown key, no tenant-existence oracle)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/t/this-tenant-does-not-exist-at-all/content`,
      headers: { authorization: "Bearer wdsk_anything" },
    });
    expect(res.statusCode).toBe(401);
  });
});
