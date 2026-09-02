import { describe, it, expect, vi, beforeEach } from "vitest";
import { listGithubRepos, classifyGithubOrgUnavailable } from "./githubRepos-data";
import { PlatformError } from "./platform";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

// §25's own flagged state: EVERY route 403s for EVERY principal today (no `resource_github_repo.
// yaml` yet — GH-03). This suite exists specifically to pin that this reader turns a 403 into
// `{ok:false, reason:"refused"}` — rendered as ReadRefusal — and never coalesces it into an empty,
// "successfully read zero repos" result. Coalescing a refusal into an empty list is exactly the
// "empty list is a claim" failure mode this repo's own conventions warn about (root MEMORY.md).
describe("listGithubRepos", () => {
  it("returns ok:false, reason:refused on a 403 — never {ok:true, repos:[]}", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
    const result = await listGithubRepos("u1", "t1");
    expect(result).toEqual({ ok: false, reason: "refused" });
  });

  it("returns ok:false, reason:unavailable on a 404/500 — the endpoint being unreachable, not a real answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    expect(await listGithubRepos("u1", "t1")).toEqual({ ok: false, reason: "unavailable" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    expect(await listGithubRepos("u1", "t1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns the envelope verbatim on 200 — {repos,total,limit,offset}, not unwrapped to a bare array", async () => {
    const payload = { repos: [{ id: "r1", fullName: "gaiadabali/r1" }], total: 1, limit: 50, offset: 0 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const result = await listGithubRepos("u1", "t1");
    expect(result).toEqual({ ok: true, data: payload });
  });

  it("omits linked/archived from the query string entirely when unset — 'both states', not a guessed default", async () => {
    let capturedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ repos: [], total: 0, limit: 50, offset: 0 }), { status: 200 });
    }));
    await listGithubRepos("u1", "t1", {});
    expect(capturedUrl).not.toContain("linked=");
    expect(capturedUrl).not.toContain("archived=");
  });

  // GHT-3 — the third failure state. GHT-1's resolver throws a 503 with one of two known message
  // strings when there is no reachable org tenant (unset config, or a different root); this reader
  // must tell that apart from a real 503 outage rather than lumping both into "unavailable" — an
  // operator retrying a config gap forever is exactly the confident-wrong-answer this ticket exists
  // to stop.
  it("returns ok:false, reason:no_org on the 503 GHT-1 throws for an unconfigured org tenant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "github org tenant misconfigured: GITHUB_REPO_SYNC_TENANT_ID is unset" }),
      { status: 503 },
    )));
    expect(await listGithubRepos("u1", "t1")).toEqual({ ok: false, reason: "no_org" });
  });

  it("returns ok:false, reason:no_org on the 503 GHT-1 throws for a different-root tenant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "no GitHub org registered for this company's root" }),
      { status: 503 },
    )));
    expect(await listGithubRepos("u1", "t1")).toEqual({ ok: false, reason: "no_org" });
  });

  it("a 403 never renders as no_org or an empty registry — the three states stay distinct", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
    const result = await listGithubRepos("u1", "t1");
    expect(result).not.toEqual({ ok: true, data: { repos: [], total: 0, limit: 50, offset: 0 } });
    expect(result).toEqual({ ok: false, reason: "refused" });
  });

  it("a 503 with an UNRECOGNIZED message is 'unavailable', not guessed to be no_org", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "database connection pool exhausted" }), { status: 503 })));
    expect(await listGithubRepos("u1", "t1")).toEqual({ ok: false, reason: "unavailable" });
  });

  describe("classifyGithubOrgUnavailable", () => {
    it("is false for any status other than 503, regardless of message", () => {
      expect(classifyGithubOrgUnavailable(new PlatformError(403, "github org tenant misconfigured"))).toBe(false);
      expect(classifyGithubOrgUnavailable(new PlatformError(500, "no GitHub org registered for this company's root"))).toBe(false);
    });

    it("is case-insensitive over the known message fragments", () => {
      expect(classifyGithubOrgUnavailable(new PlatformError(503, "GITHUB ORG TENANT MISCONFIGURED: oops"))).toBe(true);
    });
  });

  it("serializes linked/archived as the literal strings the controller requires", async () => {
    let capturedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ repos: [], total: 0, limit: 50, offset: 0 }), { status: 200 });
    }));
    await listGithubRepos("u1", "t1", { linked: false, archived: true, search: "north wind", limit: 10, offset: 20 });
    expect(capturedUrl).toContain("/api/t1/github/repos?");
    expect(capturedUrl).toContain("linked=false");
    expect(capturedUrl).toContain("archived=true");
    expect(capturedUrl).toContain("search=north+wind");
    expect(capturedUrl).toContain("limit=10");
    expect(capturedUrl).toContain("offset=20");
  });
});
