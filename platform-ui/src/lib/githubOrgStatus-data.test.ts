import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGithubOrgStatus } from "./githubOrgStatus-data";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

// GHT-2 reader — same three-state shape as `githubRepos-data.ts`'s `listGithubRepos`, driven by the
// SAME classifier (`classifyGithubOrgUnavailable`) so the two readers can never disagree about what
// a given 503 means.
describe("getGithubOrgStatus", () => {
  it("returns ok:true with the envelope verbatim on 200", async () => {
    const payload = {
      org: { login: "gaiadabali", tenantId: "co-agency", tenantName: "Gaia Digital Agency" },
      apps: [],
      sync: { asOf: "2026-09-02T00:00:00Z", lastRepoSyncAt: null, lastWebhookReceivedAt: null, lastWebhookErrorClass: null },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    expect(await getGithubOrgStatus("u1", "t1")).toEqual({ ok: true, data: payload });
  });

  it("returns ok:false, reason:refused on a 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
    expect(await getGithubOrgStatus("u1", "t1")).toEqual({ ok: false, reason: "refused" });
  });

  it("returns ok:false, reason:no_org on GHT-1's unconfigured-org 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "github org tenant misconfigured: GITHUB_REPO_SYNC_TENANT_ID is unset" }),
      { status: 503 },
    )));
    expect(await getGithubOrgStatus("u1", "t1")).toEqual({ ok: false, reason: "no_org" });
  });

  it("returns ok:false, reason:unavailable on a 500 or an unrecognized 503", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    expect(await getGithubOrgStatus("u1", "t1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("hits GET /api/:t/github/org-status", async () => {
    let capturedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ org: { login: "x", tenantId: "t1", tenantName: null }, apps: [], sync: { asOf: "now", lastRepoSyncAt: null, lastWebhookReceivedAt: null, lastWebhookErrorClass: null } }), { status: 200 });
    }));
    await getGithubOrgStatus("u1", "t1");
    expect(capturedUrl).toBe("http://p.test/api/t1/github/org-status");
  });
});
