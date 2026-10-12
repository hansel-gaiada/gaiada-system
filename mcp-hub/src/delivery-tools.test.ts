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

  // M6-P4n: a blank or echoed design must fail the tool, not become the design stage's artifact.
  it("design.prototype refuses an empty generation and the gateway's echo fallback", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { text: "" }));
    await expect(getTool("design.prototype")!.handler({ prd: "build a login page" }, principal)).rejects.toThrow(/returned no text/);
    vi.stubGlobal("fetch", mockFetch(200, { text: "[echo — no provider key configured] You are a senior product designer" }));
    await expect(getTool("design.prototype")!.handler({ prd: "build a login page" }, principal)).rejects.toThrow(/echo fallback/);
  });

  it("design.prototype requires a prd", async () => {
    await expect(getTool("design.prototype")!.handler({ prd: "" }, principal)).rejects.toThrow(/prd required/);
  });

  // M6-P4b1: code.scaffold is no longer a Gateway text stub. It starts an ai-agents runner job and returns the goal id.
  describe("code.scaffold v2 (a runner job starter, dry run)", () => {
    const savedRunner = { url: config.agentRunnerUrl, token: config.agentRunnerToken };
    const full = {
      tenantId: "aaaaaaaa-0000-4000-8000-000000000001",
      contractSnapshotId: "bbbbbbbb-0000-4000-8000-000000000002",
      siteKind: "node",
      prdArtifact: "11111111-1111-4111-8111-111111111111",
      prototypeArtifact: "22222222-2222-4222-8222-222222222222",
      repoUrl: "https://github.com/gaiada/acme-site",
      runId: "run-9",
    };
    beforeEach(() => {
      config.agentRunnerUrl = "http://runner.test";
      config.agentRunnerToken = "runner-token";
    });
    afterEach(() => {
      config.agentRunnerUrl = savedRunner.url;
      config.agentRunnerToken = savedRunner.token;
    });

    const accepted = () => vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}), text: async () => JSON.stringify({ id: "goal-1", status: "queued" }) })) as unknown as typeof fetch;

    it("is a LOW-impact write that never touches the Gateway", () => {
      const t = getTool("code.scaffold")!;
      expect(t.write).toBe(true);
      expect(t.impact).toBe("low");
      expect(JSON.stringify(t.inputSchema)).toContain("contractSnapshotId");
    });

    it("posts the frozen envelope as the goal of agent code-scaffold-v2, forwarding the caller's identity, and returns the goal id", async () => {
      const f = accepted();
      vi.stubGlobal("fetch", f);
      const out = JSON.parse(await getTool("code.scaffold")!.handler(full, principal));
      expect(out).toMatchObject({ goalId: "goal-1", status: "queued", mode: "dry_run", siteKind: "node" });
      expect(out.content).toMatch(/goal-1.*dry run.*agents\.status/);

      const [url, init] = (f as unknown as { mock: { calls: [string, { method: string; body: string; headers: Record<string, string> }][] } }).mock.calls[0];
      expect(url).toBe("http://runner.test/goals");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ tenantId: full.tenantId, agent: "code-scaffold-v2", envelope: { provider: "n8n", externalId: "wf:delivery" } });
      expect(JSON.parse(body.goal)).toEqual({
        runId: "run-9",
        repoUrl: full.repoUrl,
        siteKind: "node",
        prdArtifact: full.prdArtifact,
        prototypeArtifact: full.prototypeArtifact,
        contractSnapshotId: full.contractSnapshotId,
        constraints: { blockLibraryVersion: "", maxRevise: 3 },
      });
    });

    it("sends no push target and no mode: the job is dry-run only", async () => {
      const f = accepted();
      vi.stubGlobal("fetch", f);
      await getTool("code.scaffold")!.handler({ ...full, mode: "push", remoteUrl: "https://x/y.git" }, principal);
      const sent = (f as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0][1].body;
      expect(sent).not.toMatch(/push|remote/i);
    });

    // M6-P4b2: provisionedSiteId asks the finished job to hand its tree to platform-nest (first fill). It rides BESIDE the
    // frozen envelope as `commit`, and nothing else changes: still no remote, no mode, no credential.
    it("with provisionedSiteId, the goal carries commit: {provisionedSiteId} beside the unchanged envelope", async () => {
      const f = accepted();
      vi.stubGlobal("fetch", f);
      const site = "cccccccc-0000-4000-8000-000000000003";
      const out = JSON.parse(await getTool("code.scaffold")!.handler({ ...full, provisionedSiteId: site }, principal));
      expect(out).toMatchObject({ goalId: "goal-1", commitRequested: true });
      expect(out.content).toMatch(/platform-nest commits the tree to provisioned site/);
      const sent = (f as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0][1].body;
      const goal = JSON.parse(JSON.parse(sent).goal);
      expect(goal.commit).toEqual({ provisionedSiteId: site });
      const { commit: _c, ...envelope } = goal;
      expect(envelope).toEqual({
        runId: "run-9", repoUrl: full.repoUrl, siteKind: "node", prdArtifact: full.prdArtifact, prototypeArtifact: full.prototypeArtifact,
        contractSnapshotId: full.contractSnapshotId, constraints: { blockLibraryVersion: "", maxRevise: 3 },
      });
      expect(sent).not.toMatch(/push|remote|token/i);
    });

    it("refuses a provisionedSiteId that is not a uuid, before any call; without one, commitRequested is false", async () => {
      const f = accepted();
      vi.stubGlobal("fetch", f);
      await expect(getTool("code.scaffold")!.handler({ ...full, provisionedSiteId: "acme-site" }, principal)).rejects.toThrow(/provisionedSiteId must be/);
      expect(f).not.toHaveBeenCalled();
      const out = JSON.parse(await getTool("code.scaffold")!.handler(full, principal));
      expect(out.commitRequested).toBe(false);
    });

    it("still accepts the legacy wf:delivery keys prd / prototype / repo as aliases", async () => {
      const f = accepted();
      vi.stubGlobal("fetch", f);
      await getTool("code.scaffold")!.handler(
        { tenantId: full.tenantId, contractSnapshotId: full.contractSnapshotId, siteKind: "astro", prd: "ref-prd", prototype: "ref-proto", repo: "acme-site" },
        principal,
      );
      const goal = JSON.parse(JSON.parse((f as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0][1].body).goal);
      expect(goal).toMatchObject({ prdArtifact: "ref-prd", prototypeArtifact: "ref-proto", repoUrl: "acme-site", runId: "unbound" });
    });

    it("refuses each missing required field by name, before any call", async () => {
      const f = accepted();
      vi.stubGlobal("fetch", f);
      const h = getTool("code.scaffold")!.handler;
      await expect(h({ ...full, tenantId: "" }, principal)).rejects.toThrow(/tenantId required/);
      await expect(h({ ...full, prdArtifact: "" }, principal)).rejects.toThrow(/prdArtifact and prototypeArtifact required/);
      await expect(h({ ...full, prototypeArtifact: "" }, principal)).rejects.toThrow(/prdArtifact and prototypeArtifact required/);
      await expect(h({ ...full, contractSnapshotId: "" }, principal)).rejects.toThrow(/contractSnapshotId required/);
      await expect(h({ ...full, siteKind: "php-legacy" }, principal)).rejects.toThrow(/siteKind must be one of astro, node, wp/);
      // the legacy {prd, prototype, repo} call from wf:delivery carries no snapshot id or kind, and is refused plainly
      await expect(h({ prd: "p", prototype: "q", repo: "r", tenantId: full.tenantId }, principal)).rejects.toThrow(/contractSnapshotId required/);
      expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    });

    // M6-P4e3: the runner files a scaffold goal idempotently (site + snapshot) and answers 200 { id, status, deduped: true }
    // with the EXISTING goal's id; the tool surfaces it, and a fresh goal reports deduped: false (additive field).
    it("surfaces a deduplicated goal: the existing goal's id and status, deduped true, and no new job is claimed", async () => {
      const site = "cccccccc-0000-4000-8000-000000000003";
      const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => JSON.stringify({ id: "goal-1", status: "running", deduped: true }) })) as unknown as typeof fetch;
      vi.stubGlobal("fetch", f);
      const out = JSON.parse(await getTool("code.scaffold")!.handler({ ...full, provisionedSiteId: site }, principal));
      expect(out).toMatchObject({ goalId: "goal-1", status: "running", deduped: true, commitRequested: true, mode: "dry_run" });
      expect(out.content).toMatch(/already exists.*provisioned site.*no new job was queued/);
      expect(out.content).not.toMatch(/queued \(/);
    });

    it("a freshly filed goal reports deduped false; the rest of the output contract is unchanged", async () => {
      vi.stubGlobal("fetch", accepted());
      const out = JSON.parse(await getTool("code.scaffold")!.handler(full, principal));
      expect(out).toMatchObject({ goalId: "goal-1", status: "queued", mode: "dry_run", siteKind: "node", contractSnapshotId: full.contractSnapshotId, commitRequested: false, deduped: false });
      expect(typeof out.content).toBe("string");
    });

    it("sends the same goal text for the same inputs, so the runner derives the same key (site + snapshot ride in it)", async () => {
      const f = accepted();
      vi.stubGlobal("fetch", f);
      const site = "cccccccc-0000-4000-8000-000000000003";
      const h = getTool("code.scaffold")!.handler;
      await h({ ...full, provisionedSiteId: site }, principal);
      await h({ ...full, provisionedSiteId: site }, principal);
      const goals = (f as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls.map((c) => JSON.parse(JSON.parse(c[1].body).goal));
      expect(goals[0]).toEqual(goals[1]);
      expect(goals[0]).toMatchObject({ contractSnapshotId: full.contractSnapshotId, commit: { provisionedSiteId: site } });
    });

    it("surfaces the runner's own refusal (a full queue) instead of a bare failure", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '{"error":"goal queue full"}' })) as unknown as typeof fetch);
      await expect(getTool("code.scaffold")!.handler(full, principal)).rejects.toThrow(/429.*goal queue full/);
    });

    it("says plainly when no runner is configured", async () => {
      config.agentRunnerUrl = "";
      await expect(getTool("code.scaffold")!.handler(full, principal)).rejects.toThrow(/agent runner not configured/);
    });
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
