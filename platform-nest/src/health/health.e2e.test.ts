// Port stage 1 smoke: proves the toolchain end-to-end — NestJS + Fastify adapter + SWC
// decorator metadata + vitest inject — and that /health matches the Fastify contract shape.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";

describe("health (nest port stage 1)", () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns { ok:true, modules:[] } at the root (not under /api)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; modules: string[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.modules)).toBe(true);
  });

  // docs/modules/VERSIONING.md: the deployed build must be able to state its own app version.
  // Unset reports "unknown" rather than a stale default, so a mis-wired deploy is visible.
  it("GET /health reports the app version", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = res.json() as { version: string };
    expect(typeof body.version).toBe("string");
    expect(body.version).toBe(process.env.APP_VERSION?.trim() || "unknown");
  });
});
