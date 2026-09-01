import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerDeliveryTools } from "./delivery-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";
import { config } from "./config";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:delivery" });
function mockFetch(status: number, body: unknown, isJson = true) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (isJson ? JSON.stringify(body) : String(body)) })) as unknown as typeof fetch;
}

describe("WS11 delivery tools", () => {
  const saved = { dep: config.deployStagingUrl, platformUrl: config.platformUrl };
  beforeEach(() => {
    resetRegistry();
    registerDeliveryTools();
    config.deployStagingUrl = "";
    config.platformUrl = "http://platform.test";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.deployStagingUrl = saved.dep;
    config.platformUrl = saved.platformUrl;
  });

  it("registers design/code + github/deploy tools", () => {
    for (const n of ["design.prototype", "code.scaffold", "github.repoStatus", "github.createRepo", "deploy.staging", "deploy.production"]) {
      expect(getTool(n)).toBeDefined();
    }
  });

  it("design.prototype wraps the Gateway and returns { content }", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { text: "# Prototype\nscreens..." }));
    const out = await getTool("design.prototype")!.handler({ prd: "build a login page" }, principal);
    expect(JSON.parse(out)).toEqual({ content: "# Prototype\nscreens..." });
  });

  it("design.prototype requires a prd; code.scaffold requires prd + prototype", async () => {
    await expect(getTool("design.prototype")!.handler({ prd: "" }, principal)).rejects.toThrow(/prd required/);
    await expect(getTool("code.scaffold")!.handler({ prd: "x", prototype: "" }, principal)).rejects.toThrow(/prd and prototype required/);
  });

  it("code.scaffold wraps the Gateway", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { text: "## Plan\nfile tree..." }));
    const out = await getTool("code.scaffold")!.handler({ prd: "p", prototype: "proto", repo: "org/site" }, principal);
    expect(JSON.parse(out)).toEqual({ content: "## Plan\nfile tree..." });
  });

  // GH-12 — github.createRepo is a PERMANENT refusal in the hub, not a "not configured yet" state:
  // the hub holds only the read-only App and must never write to GitHub. No config value can enable
  // it, unlike deploy.staging/production below.
  it("github.createRepo always refuses in the hub and names the D14 approval path", async () => {
    await expect(getTool("github.createRepo")!.handler({ tenantId: "t1", name: "site" }, principal)).rejects.toThrow(
      /read-only GitHub App|creation-requests/,
    );
  });

  it("github.repoStatus requires tenantId and repo", async () => {
    await expect(getTool("github.repoStatus")!.handler({ repo: "site" }, principal)).rejects.toThrow(/tenantId required/);
    await expect(getTool("github.repoStatus")!.handler({ tenantId: "t1" }, principal)).rejects.toThrow(/repo required/);
  });

  // GH-12 — github.repoStatus now forwards (OBO) to platform-nest's own repo registry (GH-08)
  // instead of calling api.github.com directly; the hub holds no GitHub credential at all.
  it("github.repoStatus reports exists/absent via the platform registry, never GitHub directly", async () => {
    const fetchMock = mockFetch(200, { repos: [{ name: "site", fullName: "gaiada/site", defaultBranch: "main" }], total: 1 });
    vi.stubGlobal("fetch", fetchMock);
    const out = await getTool("github.repoStatus")!.handler({ tenantId: "t1", repo: "site" }, principal);
    expect(JSON.parse(out)).toMatchObject({ exists: true, fullName: "gaiada/site", defaultBranch: "main" });
    expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toContain("platform.test/api/t1/github/repos");

    vi.stubGlobal("fetch", mockFetch(200, { repos: [], total: 0 }));
    expect(JSON.parse(await getTool("github.repoStatus")!.handler({ tenantId: "t1", repo: "site" }, principal))).toMatchObject({ exists: false });
  });

  it("github.repoStatus does not report a false positive on a substring match", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { repos: [{ name: "site-old", fullName: "gaiada/site-old", defaultBranch: "main" }], total: 1 }));
    expect(JSON.parse(await getTool("github.repoStatus")!.handler({ tenantId: "t1", repo: "site" }, principal))).toMatchObject({ exists: false });
  });

  it("deploy.staging is LOW impact, fails CLOSED when unconfigured, dispatches when set", async () => {
    const t = getTool("deploy.staging")!;
    expect(t.write).toBe(true);
    expect(t.impact).toBe("low");
    await expect(t.handler({ repo: "gaiada/site" }, principal)).rejects.toThrow(/not enabled/);
    config.deployStagingUrl = "https://ci.example/dispatch";
    vi.stubGlobal("fetch", mockFetch(200, "queued", false));
    expect(JSON.parse(await t.handler({ repo: "gaiada/site", ref: "main", runId: "r1" }, principal))).toMatchObject({ dispatched: true, repo: "gaiada/site" });
  });

  it("deploy.production is HIGH impact, fails CLOSED when unconfigured, dispatches to the production target when set", async () => {
    const t = getTool("deploy.production")!;
    expect(t.write).toBe(true);
    expect(t.impact).toBe("high");
    await expect(t.handler({ repo: "gaiada/site" }, principal)).rejects.toThrow(/not enabled/);
    config.deployProductionUrl = "https://ci.example/dispatch-prod";
    vi.stubGlobal("fetch", mockFetch(200, "queued", false));
    expect(JSON.parse(await t.handler({ repo: "gaiada/site", ref: "main", runId: "r1" }, principal))).toMatchObject({ dispatched: true, repo: "gaiada/site", target: "production" });
  });
});
