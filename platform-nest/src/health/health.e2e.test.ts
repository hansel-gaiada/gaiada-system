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
});
