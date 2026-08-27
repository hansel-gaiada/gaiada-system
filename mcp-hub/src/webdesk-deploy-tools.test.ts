import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWebdeskDeployTools } from "./webdesk-deploy-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";
import { config } from "./config";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:wd-contract-watch" });

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("webdesk.deploy.probeReachability", () => {
  const saved = { url: config.webdeskDeployUrl, token: config.webdeskDeployToken };
  beforeEach(() => {
    resetRegistry();
    registerWebdeskDeployTools();
    config.webdeskDeployUrl = "";
    config.webdeskDeployToken = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.webdeskDeployUrl = saved.url;
    config.webdeskDeployToken = saved.token;
  });

  it("registers as a read-only tool (no write flag)", () => {
    const t = getTool("webdesk.deploy.probeReachability");
    expect(t).toBeDefined();
    expect(t!.write).toBeFalsy();
    expect(t!.minAssurance).toBe("low");
  });

  it("fails CLOSED when WEBDESK_DEPLOY_URL is unset, same doctrine as deploy.staging/deploy.production", async () => {
    await expect(getTool("webdesk.deploy.probeReachability")!.handler({ target: "staging" }, principal)).rejects.toThrow(/not enabled/);
  });

  it("refuses an invalid target before ever calling fetch", async () => {
    config.webdeskDeployUrl = "http://webdesk-deploy:3210";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getTool("webdesk.deploy.probeReachability")!.handler({ target: "prod" }, principal)).rejects.toThrow(/staging.*production|production.*staging/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls POST /probe with the bearer token and returns the service's result verbatim", async () => {
    config.webdeskDeployUrl = "http://webdesk-deploy:3210";
    config.webdeskDeployToken = "svc-token";
    const result = { target: "staging", host: "72.61.142.88", reachable: true, checkedAt: "2026-08-27T00:00:00.000Z", detail: "ssh exited 0" };
    const fetchSpy = mockFetch(200, result);
    vi.stubGlobal("fetch", fetchSpy);

    const out = JSON.parse(await getTool("webdesk.deploy.probeReachability")!.handler({ target: "staging" }, principal));
    expect(out).toEqual(result);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://webdesk-deploy:3210/probe",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer svc-token", "Content-Type": "application/json" }),
        body: JSON.stringify({ target: "staging" }),
      }),
    );
  });

  it("surfaces an unreachable result honestly — 200 + reachable:false is not an error", async () => {
    config.webdeskDeployUrl = "http://webdesk-deploy:3210";
    const result = { target: "production", host: "187.77.116.133", reachable: false, checkedAt: "2026-08-27T00:00:00.000Z", detail: "ssh timed out after 10s" };
    vi.stubGlobal("fetch", mockFetch(200, result));
    const out = JSON.parse(await getTool("webdesk.deploy.probeReachability")!.handler({ target: "production" }, principal));
    expect(out.reachable).toBe(false);
  });

  it("propagates the service's own error token on a non-2xx response", async () => {
    config.webdeskDeployUrl = "http://webdesk-deploy:3210";
    vi.stubGlobal("fetch", mockFetch(401, { error: "unauthorized" }));
    await expect(getTool("webdesk.deploy.probeReachability")!.handler({ target: "staging" }, principal)).rejects.toThrow(/unauthorized/);
  });
});
