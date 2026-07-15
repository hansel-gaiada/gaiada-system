import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import { resetRegistry, getTool } from "./registry";
import { registerCoreTools } from "./tools";
import { mintPrincipal } from "./principal";

const exec = { ...mintPrincipal({ provider: "platform", externalId: "u:exec" }), assurance: "verified" as const };

describe("deployment topology (WS2 §7)", () => {
  beforeEach(() => {
    resetRegistry();
    registerCoreTools();
    config.platformUrl = "http://platform.test";
    config.platformToken = "plat-token";
  });
  afterEach(() => {
    config.topology = "site";
    vi.unstubAllGlobals();
  });

  it("a SITE hub returns a central-only note for rollup.metrics (no platform call)", async () => {
    config.topology = "site";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await getTool("rollup.metrics")!.handler({}, exec);
    expect(JSON.parse(out)).toMatchObject({ topology: "site" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a CENTRAL hub fronts the platform's cross-company /rollups read with the OBO envelope", async () => {
    config.topology = "central";
    const spy = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe("http://platform.test/rollups?period=2026-07-15");
      expect(init?.headers?.["x-obo-external-id"]).toBe("u:exec");
      return { ok: true, status: 200, json: async () => [{ company: "Agency", metric_key: "agency.utilization" }] };
    });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("rollup.metrics")!.handler({ period: "2026-07-15" }, exec);
    expect(out).toContain("agency.utilization");
  });
});
