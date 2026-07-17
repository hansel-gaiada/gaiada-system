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
  const saved = { gh: config.githubToken, org: config.githubOrg, dep: config.deployStagingUrl };
  beforeEach(() => {
    resetRegistry();
    registerDeliveryTools();
    config.githubToken = ""; config.githubOrg = ""; config.deployStagingUrl = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.githubToken = saved.gh; config.githubOrg = saved.org; config.deployStagingUrl = saved.dep;
  });

  it("registers design/code + github/deploy tools", () => {
    for (const n of ["design.prototype", "code.scaffold", "github.repoStatus", "github.createRepo", "deploy.staging"]) {
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

  it("github.repoStatus fails CLOSED when unconfigured, and github.createRepo is not enabled", async () => {
    await expect(getTool("github.repoStatus")!.handler({ repo: "site" }, principal)).rejects.toThrow(/not enabled/);
    await expect(getTool("github.createRepo")!.handler({ name: "site" }, principal)).rejects.toThrow(/not enabled/);
  });

  it("github.repoStatus reports exists/absent when configured", async () => {
    config.githubToken = "ght"; config.githubOrg = "gaiada";
    vi.stubGlobal("fetch", mockFetch(200, { full_name: "gaiada/site", default_branch: "main" }));
    expect(JSON.parse(await getTool("github.repoStatus")!.handler({ repo: "site" }, principal))).toMatchObject({ exists: true, fullName: "gaiada/site", defaultBranch: "main" });
    vi.stubGlobal("fetch", mockFetch(404, {}));
    expect(JSON.parse(await getTool("github.repoStatus")!.handler({ repo: "site" }, principal))).toMatchObject({ exists: false });
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
});
