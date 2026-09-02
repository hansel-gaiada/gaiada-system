// GH-06 — the fetch/enrich half of the org crawl + reconcile sweep, tested with `githubRequest`
// MOCKED (hard constraint: never call the live GitHub API from a test). `githubRequest` is the
// GH-01/GH-02 chokepoint — mocking AT that boundary means these tests exercise GH-06's own logic
// (pagination, per-repo enrichment, error tolerance) without re-testing JWT minting, token caching
// or the fairness queue, which github-app.service.test.ts already covers against a real (stubbed
// `fetch`) HTTP layer.
//
// The DB-touching half (upsert idempotency, link-column preservation, soft-delete reconcile,
// tenant isolation) lives in repo-sync.db.test.ts, gated on a real Postgres like every other
// `*.db.test.ts` in this repo.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as githubAppService from "./github-app.service";
import { GithubApiError } from "./errors";
import { collectGithubRepoData, loadRepoDetail, GITHUB_REPO_SYNC_ACTOR } from "./repo-sync.service";

vi.mock("./github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const TENANT = "tenant-1";

function repo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "foo",
    full_name: "gaiadabali/foo",
    html_url: "https://github.com/gaiadabali/foo",
    private: true,
    archived: false,
    topics: ["erp"],
    default_branch: "main",
    created_at: "2026-08-17T00:00:00Z",
    pushed_at: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

/** Queue canned responses for successive `githubRequest` calls, in call order. */
function mockResponses(responses: Array<{ data: unknown } | { throw: unknown }>) {
  const mocked = vi.mocked(githubAppService.githubRequest);
  let i = 0;
  mocked.mockImplementation(async () => {
    const next = responses[i++];
    if (!next) throw new Error(`unexpected extra githubRequest call #${i}`);
    if ("throw" in next) throw next.throw;
    return { data: next.data, status: 200, rateLimit: { limit: 5000, remaining: 4999, resetAtMs: null } };
  });
  return mocked;
}

beforeEach(() => {
  vi.mocked(githubAppService.githubRequest).mockReset();
});

describe("collectGithubRepoData — pagination (§3: 221 repos > 100/page default)", () => {
  it("follows pagination until total_count is reached", async () => {
    const page1 = { repositories: Array.from({ length: 100 }, (_, i) => repo({ name: `r${i}`, full_name: `gaiadabali/r${i}` })), total_count: 221 };
    const page2 = { repositories: Array.from({ length: 100 }, (_, i) => repo({ name: `r${100 + i}`, full_name: `gaiadabali/r${100 + i}` })), total_count: 221 };
    const page3 = { repositories: Array.from({ length: 21 }, (_, i) => repo({ name: `r${200 + i}`, full_name: `gaiadabali/r${200 + i}` })), total_count: 221 };
    mockResponses([{ data: page1 }, { data: page2 }, { data: page3 }]);

    const result = await collectGithubRepoData({
      tenantId: TENANT, role: "erp", actingUserId: GITHUB_REPO_SYNC_ACTOR, includeDetail: false, onWarn: () => {},
    });

    expect(result).toHaveLength(221);
    expect(vi.mocked(githubAppService.githubRequest)).toHaveBeenCalledTimes(3);
    const calledPaths = vi.mocked(githubAppService.githubRequest).mock.calls.map((c) => (c[3] as { path: string }).path);
    expect(calledPaths).toEqual([
      "/installation/repositories?per_page=100&page=1",
      "/installation/repositories?per_page=100&page=2",
      "/installation/repositories?per_page=100&page=3",
    ]);
  });

  it("stops on an empty page even if total_count claims more (defensive against a bad count)", async () => {
    mockResponses([{ data: { repositories: [repo()], total_count: 999 } }, { data: { repositories: [] } }]);
    const result = await collectGithubRepoData({
      tenantId: TENANT, role: "erp", actingUserId: GITHUB_REPO_SYNC_ACTOR, includeDetail: false, onWarn: () => {},
    });
    expect(result).toHaveLength(1);
  });

  it("zero repos returns an empty array cleanly (no crash, no infinite loop)", async () => {
    mockResponses([{ data: { repositories: [], total_count: 0 } }]);
    const result = await collectGithubRepoData({
      tenantId: TENANT, role: "erp", actingUserId: GITHUB_REPO_SYNC_ACTOR, includeDetail: false, onWarn: () => {},
    });
    expect(result).toEqual([]);
  });
});

describe("collectGithubRepoData — tier-1 identity/state fields", () => {
  it("maps visibility from the `private` boolean when `visibility` is absent", async () => {
    mockResponses([{ data: { repositories: [repo({ private: true, visibility: undefined }), repo({ name: "pub", full_name: "gaiadabali/pub", private: false, visibility: undefined })], total_count: 2 } }]);
    const result = await collectGithubRepoData({
      tenantId: TENANT, role: "erp", actingUserId: GITHUB_REPO_SYNC_ACTOR, includeDetail: false, onWarn: () => {},
    });
    expect(result.find((r) => r.name === "foo")?.visibility).toBe("private");
    expect(result.find((r) => r.name === "pub")?.visibility).toBe("public");
  });

  it("archived is carried through as a first-class field, not inferred", async () => {
    mockResponses([{ data: { repositories: [repo({ archived: true })], total_count: 1 } }]);
    const result = await collectGithubRepoData({
      tenantId: TENANT, role: "erp", actingUserId: GITHUB_REPO_SYNC_ACTOR, includeDetail: false, onWarn: () => {},
    });
    expect(result[0].archived).toBe(true);
  });

  it("with includeDetail=false, no per-repo detail calls are made at all — only the list call(s)", async () => {
    const mocked = mockResponses([{ data: { repositories: [repo(), repo({ name: "bar", full_name: "gaiadabali/bar" })], total_count: 2 } }]);
    const result = await collectGithubRepoData({
      tenantId: TENANT, role: "erp", actingUserId: GITHUB_REPO_SYNC_ACTOR, includeDetail: false, onWarn: () => {},
    });
    expect(mocked).toHaveBeenCalledTimes(1); // just the one list page, no enrichment calls
    expect(result[0].headSha).toBeNull();
    expect(result[0].openPrCount).toBe(0);
  });
});

describe("loadRepoDetail — tier-2 best-effort enrichment", () => {
  it("populates head commit / open PR count / latest run / latest release on full success", async () => {
    const mocked = mockResponses([
      { data: { sha: "abc123", commit: { author: { name: "Jane Dev", email: "jane@gaiada.com", date: "2026-08-20T00:00:00Z" } } } },
      { data: [{}, {}] }, // 2 open PRs
      { data: { workflow_runs: [{ status: "completed", conclusion: "success", run_started_at: "2026-08-19T00:00:00Z" }] } },
      { data: { tag_name: "v1.2.0" } },
    ]);
    const warnings: string[] = [];
    const detail = await loadRepoDetail(TENANT, "erp", GITHUB_REPO_SYNC_ACTOR, repo(), (m) => warnings.push(m));

    expect(detail.headSha).toBe("abc123");
    expect(detail.headAuthor).toBe("Jane Dev <jane@gaiada.com>");
    expect(detail.headCommittedAt).toBe("2026-08-20T00:00:00Z");
    expect(detail.openPrCount).toBe(2);
    expect(detail.latestRunStatus).toBe("completed");
    expect(detail.latestRunConclusion).toBe("success");
    expect(detail.latestReleaseTag).toBe("v1.2.0");
    expect(warnings).toEqual([]);
    expect(mocked).toHaveBeenCalledTimes(4);
  });

  it("skips the head-commit call entirely for a never-pushed repo (pushed_at null) — the list call already answered it", async () => {
    const mocked = mockResponses([
      { data: [] }, // open PRs
      { data: { workflow_runs: [] } }, // actions runs
      { throw: new GithubApiError("GET /repos/x/releases/latest", 404) }, // no releases
    ]);
    const detail = await loadRepoDetail(TENANT, "erp", GITHUB_REPO_SYNC_ACTOR, repo({ pushed_at: null }), () => {});
    expect(detail.headSha).toBeNull();
    expect(mocked).toHaveBeenCalledTimes(3); // no /commits/ call at all
  });

  it("a 404 on releases/latest is treated as 'no release', NOT a warning (§5.1: a true fact)", async () => {
    mockResponses([
      { data: { sha: "s", commit: { author: { name: "A", date: "2026-08-01T00:00:00Z" } } } },
      { data: [] },
      { data: { workflow_runs: [] } },
      { throw: new GithubApiError("GET /repos/gaiadabali/foo/releases/latest", 404) },
    ]);
    const warnings: string[] = [];
    const detail = await loadRepoDetail(TENANT, "erp", GITHUB_REPO_SYNC_ACTOR, repo(), (m) => warnings.push(m));
    expect(detail.latestReleaseTag).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("one sub-fetch failing (non-404) degrades that field to null/default and WARNS, but does not throw or block the others", async () => {
    mockResponses([
      { throw: new Error("network blip") }, // head commit
      { data: [{}] }, // 1 open PR
      { throw: new GithubApiError("GET actions/runs", 502) }, // actions runs
      { data: { tag_name: "v9" } }, // release
    ]);
    const warnings: string[] = [];
    const detail = await loadRepoDetail(TENANT, "erp", GITHUB_REPO_SYNC_ACTOR, repo(), (m) => warnings.push(m));

    expect(detail.headSha).toBeNull();
    expect(detail.openPrCount).toBe(1); // unaffected sibling call still succeeded
    expect(detail.latestRunStatus).toBeNull();
    expect(detail.latestReleaseTag).toBe("v9"); // unaffected sibling call still succeeded
    expect(warnings.some((w) => w.includes("head commit"))).toBe(true);
    expect(warnings.some((w) => w.includes("actions runs"))).toBe(true);
    expect(warnings).toHaveLength(2); // the two genuine failures, no more
  });

  it("all four sub-fetches failing still resolves (never throws) — the crawl must survive one bad repo", async () => {
    mockResponses([
      { throw: new Error("x") },
      { throw: new Error("x") },
      { throw: new Error("x") },
      { throw: new Error("x") },
    ]);
    const warnings: string[] = [];
    await expect(loadRepoDetail(TENANT, "erp", GITHUB_REPO_SYNC_ACTOR, repo(), (m) => warnings.push(m))).resolves.toBeDefined();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("collectGithubRepoData — end to end with detail enabled", () => {
  it("enriches every repo returned by the list call", async () => {
    mockResponses([
      { data: { repositories: [repo()], total_count: 1 } },
      { data: { sha: "s1", commit: { author: { name: "A", date: "2026-08-01T00:00:00Z" } } } },
      { data: [] },
      { data: { workflow_runs: [] } },
      { throw: new GithubApiError("GET releases/latest", 404) },
    ]);
    const result = await collectGithubRepoData({
      tenantId: TENANT, role: "erp", actingUserId: GITHUB_REPO_SYNC_ACTOR, includeDetail: true, onWarn: () => {},
    });
    expect(result).toHaveLength(1);
    expect(result[0].headSha).toBe("s1");
  });
});
