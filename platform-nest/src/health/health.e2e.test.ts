// Port stage 1 smoke: proves the toolchain end-to-end — NestJS + Fastify adapter + SWC
// decorator metadata + vitest inject — and that /health matches the Fastify contract shape.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";

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

// SCP-Sa (plan §8, SCP-S "Sa"): the social simulator's switch is visible from outside, an additive field that is always
// a real boolean. Read at call time, so flipping config flips the answer without a rebuild.
describe("health: the social simulator's switch (SCP-Sa)", () => {
  let app: NestFastifyApplication;
  const before = config.socialSimulationEnabled;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    config.socialSimulationEnabled = before;
    await app.close();
  });

  it("GET /health reports socialSimulation, false by default and true while the switch is on", async () => {
    const off = (await app.inject({ method: "GET", url: "/health" })).json() as { socialSimulation: unknown };
    expect(off.socialSimulation).toBe(false);
    config.socialSimulationEnabled = true;
    const on = (await app.inject({ method: "GET", url: "/health" })).json() as { socialSimulation: unknown; ok: boolean };
    expect(on.socialSimulation).toBe(true);
    expect(on.ok).toBe(true);
    config.socialSimulationEnabled = false;
    const offAgain = (await app.inject({ method: "GET", url: "/health" })).json() as { socialSimulation: unknown };
    expect(offAgain.socialSimulation).toBe(false);
  });
});
