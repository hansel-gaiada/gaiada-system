import { describe, it, expect, vi, beforeEach } from "vitest";
import { listGithubRepos } from "./githubRepos-data";

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
