import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "./server";
import type { DeployResult, DeployTarget, FrontendDeployDriver, ReachabilityResult } from "./types";

const TOKEN = "test-service-token";

class FakeDriver implements FrontendDeployDriver {
  probeCalls: DeployTarget[] = [];
  async probe(target: DeployTarget): Promise<ReachabilityResult> {
    this.probeCalls.push(target);
    return { target, host: "fake-host", reachable: target === "staging", checkedAt: new Date().toISOString(), detail: "ssh exited 0" };
  }
  async deploy(): Promise<DeployResult> {
    throw new Error("deploy() must never be reachable over HTTP — this test would fail if it were called");
  }
}

let server: Server;
let baseUrl: string;
let driver: FakeDriver;

beforeEach(async () => {
  driver = new FakeDriver();
  server = createServer(driver, TOKEN); // explicit token — the DI seam, not env — so auth is deterministic
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function postProbe(body: unknown, token?: string) {
  return fetch(`${baseUrl}/probe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("webdesk-deploy HTTP server", () => {
  it("GET /healthz needs no auth and reports the configured-token flag truthfully", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, serviceTokenConfigured: true });
  });

  it("POST /probe with no Authorization header is refused, driver untouched", async () => {
    const res = await postProbe({ target: "staging" });
    expect(res.status).toBe(401);
    expect(driver.probeCalls).toHaveLength(0);
  });

  it("POST /probe with a WRONG token is refused — not a prefix/substring match", async () => {
    const res = await postProbe({ target: "staging" }, "test-service-tok"); // truncated
    expect(res.status).toBe(401);
    expect(driver.probeCalls).toHaveLength(0);
  });

  it("POST /probe with the correct token succeeds and returns the driver's OWN result verbatim", async () => {
    const res = await postProbe({ target: "staging" }, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReachabilityResult;
    expect(body).toMatchObject({ target: "staging", reachable: true, detail: "ssh exited 0" });
    expect(driver.probeCalls).toEqual(["staging"]);
  });

  it("surfaces a driver-reported UNREACHABLE result as-is (200 with reachable:false) — never upgraded", async () => {
    const res = await postProbe({ target: "production" }, TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReachabilityResult;
    expect(body.reachable).toBe(false);
  });

  it("rejects an invalid target with 400 and never reaches the driver", async () => {
    const res = await postProbe({ target: "prod" }, TOKEN); // not "staging"/"production"
    expect(res.status).toBe(400);
    expect(driver.probeCalls).toHaveLength(0);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await postProbe("not json", TOKEN);
    expect(res.status).toBe(400);
    expect(driver.probeCalls).toHaveLength(0);
  });

  it("404s an unknown route, including /deploy — there is no HTTP path to the mutating call", async () => {
    const res = await fetch(`${baseUrl}/deploy`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{}" });
    expect(res.status).toBe(404);
  });

  it("fails closed even with a correct-shaped request when no token was configured at all", async () => {
    const openServer = createServer(driver, ""); // empty token — the real default when the env var is unset
    await new Promise<void>((resolve) => openServer.listen(0, resolve));
    const { port } = openServer.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer anything" },
        body: JSON.stringify({ target: "staging" }),
      });
      expect(res.status).toBe(401); // an empty configured token never matches ANY presented value
    } finally {
      await new Promise<void>((resolve) => openServer.close(() => resolve()));
    }
  });
});
