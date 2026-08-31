// GH-06 — the database half of the org crawl + reconcile sweep, against LIVE Postgres (RLS,
// FORCE, the real partial-unique arbiter). `githubRequest` is mocked (hard constraint: never call
// live GitHub from a test) so these tests exercise ONLY `syncGithubRepos`'s upsert + soft-delete
// logic against a real `github_repos` table. Schema-level RLS/FK/CHECK behaviour is already proven
// by `db/github-repos-rls.test.ts` (GH-05) — this file does not repeat that, it proves the SERVICE
// built on top of that schema:
//   * running the crawl twice does not duplicate or churn rows (idempotent upsert);
//   * the ERP-owned link columns (webdev_site_id/project_id) survive a re-sync untouched;
//   * a repo that disappears from GitHub's response is soft-deleted, not silently left stale;
//   * last_synced_at distinguishes a row the sweep confirmed from one it did not touch;
//   * tenant isolation — a sync for tenant A never touches tenant C's rows.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createProject } from "../../testing/fixtures";
import { withTenants, newId } from "../../db";
import * as githubAppService from "./github-app.service";
import { syncGithubRepos } from "./repo-sync.service";

vi.mock("./github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

function installationPage(repos: unknown[]) {
  return { data: { repositories: repos, total_count: repos.length }, status: 200, rateLimit: { limit: 5000, remaining: 4999, resetAtMs: null } };
}

function rawRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "foo",
    full_name: "gaiadabali/foo",
    html_url: "https://github.com/gaiadabali/foo",
    private: true,
    archived: false,
    topics: [],
    default_branch: "main",
    created_at: "2026-08-17T00:00:00Z",
    pushed_at: null, // avoids the head-commit call for these tests, keeping the mock queue simple
    ...overrides,
  };
}

describe.skipIf(!TEST_URL)("syncGithubRepos — DB half (GH-06)", () => {
  let A: string;
  let C: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Repo Sync Tenant A");
    C = await createCompany("Repo Sync Tenant C");
  });
  afterAll(teardownTestDb);
  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  /** Mocks a full sync pass for `fullNames`, tier-2 enrichment disabled (includeDetail:false) so
   *  each pass only needs ONE mocked call (the list page) regardless of repo count — keeping these
   *  DB-focused tests from also having to model 3 enrichment calls per repo. */
  function mockListOnly(repos: unknown[]) {
    vi.mocked(githubAppService.githubRequest).mockReset();
    vi.mocked(githubAppService.githubRequest).mockResolvedValueOnce(installationPage(repos) as never);
  }

  it("first sync inserts every repo; running it again with identical data updates in place (no duplicates)", async () => {
    const org = "gaiadabali";
    const suffix = newId().slice(-8);
    const repos = [rawRepo({ name: `r1-${suffix}`, full_name: `${org}/r1-${suffix}` }), rawRepo({ name: `r2-${suffix}`, full_name: `${org}/r2-${suffix}` })];

    mockListOnly(repos);
    const first = await syncGithubRepos({ tenantId: A, includeDetail: false });
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.fetched).toBe(2);

    mockListOnly(repos);
    const second = await syncGithubRepos({ tenantId: A, includeDetail: false });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2); // same rows, re-confirmed — not duplicated

    const count = await withTenants([A], (c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM github_repos WHERE org=$1 AND full_name = ANY($2)`,
        [org, repos.map((r) => (r as { full_name: string }).full_name)],
      ),
    );
    expect(count.rows[0].n).toBe("2"); // exactly 2 rows total across both runs, not 4
  });

  it("a re-sync NEVER overwrites a REAL ERP-owned link (project_id), even though the crawl's own data never carries one", async () => {
    const org = "gaiadabali";
    const suffix = newId().slice(-8);
    const fullName = `${org}/linked-${suffix}`;
    mockListOnly([rawRepo({ name: `linked-${suffix}`, full_name: fullName })]);
    await syncGithubRepos({ tenantId: A, includeDetail: false });

    // Simulate the BFF link endpoint (GH-08, out of this ticket's scope) having set a REAL link —
    // a genuine projects row under the SAME tenant, so the composite FK actually accepts it.
    const projectId = await createProject(A, `Linked project ${suffix}`);
    await withTenants([A], (c) => c.query(`UPDATE github_repos SET project_id = $1 WHERE full_name = $2`, [projectId, fullName]));

    // Re-sync with the SAME GitHub data. syncGithubRepos never reads or writes project_id at all —
    // if the UPDATE SET list in upsertRepoRow ever grows a `project_id = EXCLUDED.project_id` (which
    // would evaluate to NULL, since the crawl never populates it), this assertion catches it.
    mockListOnly([rawRepo({ name: `linked-${suffix}`, full_name: fullName })]);
    const result = await syncGithubRepos({ tenantId: A, includeDetail: false });
    expect(result.updated).toBe(1);

    const after = await withTenants([A], (c) =>
      c.query<{ project_id: string | null }>(`SELECT project_id FROM github_repos WHERE full_name=$1`, [fullName]),
    );
    expect(after.rows[0].project_id).toBe(projectId);
  });

  it("a repo that no longer appears in GitHub's response is SOFT-DELETED, not silently left stale", async () => {
    const org = "gaiadabali";
    const suffix = newId().slice(-8);
    const staysName = `stays-${suffix}`;
    const goesName = `goes-${suffix}`;
    mockListOnly([
      rawRepo({ name: staysName, full_name: `${org}/${staysName}` }),
      rawRepo({ name: goesName, full_name: `${org}/${goesName}` }),
    ]);
    const first = await syncGithubRepos({ tenantId: A, includeDetail: false });
    expect(first.inserted).toBe(2);

    // Second pass: GitHub no longer reports `goesName` at all (deleted/transferred out/access revoked).
    mockListOnly([rawRepo({ name: staysName, full_name: `${org}/${staysName}` })]);
    const second = await syncGithubRepos({ tenantId: A, includeDetail: false });
    expect(second.softDeleted).toBe(1);

    const rows = await withTenants([A], (c) =>
      c.query<{ full_name: string; deleted_at: Date | null }>(
        `SELECT full_name, deleted_at FROM github_repos WHERE org=$1 AND full_name IN ($2, $3)`,
        [org, `${org}/${staysName}`, `${org}/${goesName}`],
      ),
    );
    const stays = rows.rows.find((r) => r.full_name === `${org}/${staysName}`);
    const goes = rows.rows.find((r) => r.full_name === `${org}/${goesName}`);
    expect(stays!.deleted_at).toBeNull();
    expect(goes!.deleted_at).not.toBeNull();
  });

  it("an EMPTY installation response does NOT wipe an existing registry (guard against a transient empty fetch)", async () => {
    const org = "gaiadabali";
    const suffix = newId().slice(-8);
    const name = `guarded-${suffix}`;
    mockListOnly([rawRepo({ name, full_name: `${org}/${name}` })]);
    await syncGithubRepos({ tenantId: A, includeDetail: false });

    mockListOnly([]); // simulate a transient empty response
    const result = await syncGithubRepos({ tenantId: A, includeDetail: false });
    expect(result.softDeleted).toBe(0);
    expect(result.warnings.some((w) => w.includes("zero repositories"))).toBe(true);

    const row = await withTenants([A], (c) =>
      c.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM github_repos WHERE full_name=$1`, [`${org}/${name}`]),
    );
    expect(row.rows[0].deleted_at).toBeNull(); // untouched, not wiped
  });

  it("last_synced_at is bumped on every confirmed row — distinguishes a confirmed row from an untouched one", async () => {
    const org = "gaiadabali";
    const suffix = newId().slice(-8);
    const name = `fresh-${suffix}`;
    const fullName = `${org}/${name}`;
    mockListOnly([rawRepo({ name, full_name: fullName })]);
    await syncGithubRepos({ tenantId: A, includeDetail: false });

    // Artificially age the row, then re-sync — last_synced_at must move forward.
    await withTenants([A], (c) => c.query(`UPDATE github_repos SET last_synced_at = now() - interval '30 days' WHERE full_name=$1`, [fullName]));
    const before = await withTenants([A], (c) => c.query<{ last_synced_at: Date }>(`SELECT last_synced_at FROM github_repos WHERE full_name=$1`, [fullName]));

    mockListOnly([rawRepo({ name, full_name: fullName })]);
    await syncGithubRepos({ tenantId: A, includeDetail: false });
    const after = await withTenants([A], (c) => c.query<{ last_synced_at: Date }>(`SELECT last_synced_at FROM github_repos WHERE full_name=$1`, [fullName]));

    expect(after.rows[0].last_synced_at.getTime()).toBeGreaterThan(before.rows[0].last_synced_at.getTime());
  });

  it("tenant isolation: syncing for tenant A never creates or touches rows under tenant C", async () => {
    const org = "gaiadabali";
    const suffix = newId().slice(-8);
    const name = `isolated-${suffix}`;
    mockListOnly([rawRepo({ name, full_name: `${org}/${name}` })]);
    await syncGithubRepos({ tenantId: A, includeDetail: false });

    const fromC = await withTenants([C], (c) => c.query(`SELECT id FROM github_repos WHERE full_name=$1`, [`${org}/${name}`]));
    expect(fromC.rows.length).toBe(0);
  });

  it("archived state round-trips through the sync unchanged, and does not trigger soft-delete", async () => {
    // QA (GH-14): `org` is deliberately UNIQUE to this test, not the shared "gaiadabali" literal
    // every earlier `it()` in this file uses. `beforeAll` creates tenant A once for the whole file
    // (no per-test DB reset — only `vi.mocked(...).mockReset()` in `beforeEach`), and
    // `syncGithubRepos`'s soft-delete pass is scoped `WHERE tenant_id=$1 AND org=$2 AND full_name
    // <> ALL($3)` (repo-sync.service.ts) — a real, intended behaviour proven directly by the
    // "SOFT-DELETED" test above. Sharing `org="gaiadabali"` with the other tests means THIS test's
    // one-repo crawl legitimately soft-deletes whatever earlier test's repo was still live under
    // that same org — cascading, one carry-over row per test, observed as `result.softDeleted`
    // flipping from 0 to 1 depending on run order/subset (fails when the full file runs, passes
    // filtered to just this test). That is a test-isolation bug in the fixture, not a service
    // defect — a fresh, this-test-only org value removes the shared state instead of asserting
    // around it.
    const org = `qa-archived-org-${newId().slice(-8)}`;
    const suffix = newId().slice(-8);
    const name = `archived-${suffix}`;
    mockListOnly([rawRepo({ name, full_name: `${org}/${name}`, archived: true })]);
    const result = await syncGithubRepos({ tenantId: A, includeDetail: false });
    expect(result.softDeleted).toBe(0);

    const row = await withTenants([A], (c) => c.query<{ archived: boolean; deleted_at: Date | null }>(`SELECT archived, deleted_at FROM github_repos WHERE full_name=$1`, [`${org}/${name}`]));
    expect(row.rows[0].archived).toBe(true);
    expect(row.rows[0].deleted_at).toBeNull();
  });
});
