// M6-P4b2 — the scaffold commit's state machine against REAL Postgres (RLS, FORCE, the third wall on
// webdev_provisioned_sites and webdev_contract_snapshots, the migration's CHECKs, the provisioning advisory lock, the
// GH-04 ledger in `activities`, the outbox), with GitHub faked at the chokepoint: `githubRequest` is mocked to the
// in-memory fake (core/github/git-data.testkit.ts). Authorization is covered by scaffold-commit-http.test.ts; this suite
// drives the ports below it, the way provision-completion.db.test.ts drives P4c.
//
// WHAT THIS SUITE IS TRYING TO FALSIFY:
//   1. the happy path records `committed` with the tree, commit and base sha, ledgers both GitHub writes (attributed),
//      and emits webdev.site.scaffold_committed;
//   2. an identical re-submit is a no-op with no GitHub call; a different tree afterwards is refused;
//   3. a crash between "commit created" and "ref updated" resumes from the recorded commit;
//   4. two concurrent submissions of the same tree land ONE commit with ONE ref update;
//   5. the repo must be the GH-12 one for this row, the site complete, the lock the pinned snapshot;
//   6. the schema refuses a scaffold state without its links or on an incomplete site.
import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { newId } from "../../db";
import { config } from "../../config";
import * as githubAppService from "../../core/github/github-app.service";
import { GithubApiError } from "../../core/github/errors";
import { FakeGithub } from "../../core/github/git-data.testkit";
import { GITHUB_CREATE_REPO_WORKFLOW } from "../../core/github/repo-creation";
import { fileAutomationApproval } from "../../core/approval-filing";
import { ScaffoldRefusal, commitScaffoldTree } from "./scaffold-commit";
import { readScaffoldCommit, scaffoldCommitPorts } from "./scaffold-commit.service";

vi.mock("../../core/github/github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/github/github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const live = Boolean(TEST_URL);
const ORG = "acme-org";
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const file = (path: string, content: string | Buffer) => {
  const b = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return { path, base64: b.toString("base64"), sha256: sha256(b), bytes: b.byteLength };
};

describe.skipIf(!live)("M6-P4b2 — scaffold commit (real Postgres, faked GitHub)", () => {
  let T: string;
  let userId: string;
  let gh: FakeGithub;
  const saved = { org: config.githubOrg, orgTenant: config.githubOrgTenantId };

  const actor = () => ({ userId, name: "P4b2 Operator", email: "p4b2-operator@ex.test" });
  const ports = (siteId: string) => scaffoldCommitPorts({ tenantId: T, siteId, orgTenantId: T, actor: actor() });

  interface Site { id: string; runId: string; slug: string; snapshot: { id: string; contractVersion: string; vocabularyVersion: string; contentHash: string } }

  /** A provisioned row whose §08 completion is `complete`, with its GH-12 approval, run, registry row and pin. */
  async function completeSite(opts: { approvalStatus?: string; repoUrl?: (slug: string) => string; completion?: "complete" | "tenant_ready" } = {}): Promise<Site> {
    const slug = `p4b2-${newId().slice(-12)}`; // uuidv7: the first 8 hex are a timestamp prefix (shared for ~65 s), the tail is random
    const runId = newId();
    const db = adminPool();
    await db.query(`INSERT INTO pipeline_runs (id, tenant_id, status, origin_site) VALUES ($1, $2, 'delivery_active', 'main')`, [runId, T]);
    const filed = await fileAutomationApproval({
      tenantId: T, workflowId: GITHUB_CREATE_REPO_WORKFLOW, toolName: "github.createRepo",
      toolArgs: { name: slug, private: true }, impact: "high", origin: "github", requestedBy: userId,
    });
    await db.query(`UPDATE automation_approvals SET status = $2 WHERE id = $1`, [filed.id, opts.approvalStatus ?? "approved"]);
    const webdevSiteId = newId();
    await db.query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site)
       VALUES ($1, $2, $3, 'staging', 'static', $4, 'mandated', 'provisioned', 'main')`,
      [webdevSiteId, T, `${slug}.provisioned.invalid`, `https://github.com/${ORG}/${slug}`],
    );
    const snapshot = { id: newId(), contractVersion: "1.0.0", vocabularyVersion: "1.1.0", contentHash: `sha256:${sha256(Buffer.from(slug))}` };
    await db.query(
      `INSERT INTO webdev_contract_snapshots (id, tenant_id, webdesk_tenant_slug, contract_version, vocabulary_version, content_hash, artifacts, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'main')`,
      [snapshot.id, T, slug, snapshot.contractVersion, snapshot.vocabularyVersion, snapshot.contentHash],
    );
    const id = newId();
    const completion = opts.completion ?? "complete";
    await db.query(
      `INSERT INTO webdev_provisioned_sites
         (id, tenant_id, pipeline_run_id, provider, provider_ref, slug, framework, status, repo_url, requested_by, origin_site,
          completion_state, webdev_site_id, webdesk_tenant_slug, contract_snapshot_id, completion_updated_at)
       VALUES ($1, $2, $3, 'erp_repo', $4, $5, 'astro', 'live', $6, $7, 'main', $8, $9, $10, $11, now())`,
      [id, T, runId, filed.id, slug, (opts.repoUrl ?? ((s) => `https://github.com/${ORG}/${s}`))(slug), userId,
        completion, webdevSiteId, slug, completion === "complete" ? snapshot.id : null],
    );
    return { id, runId, slug, snapshot };
  }

  const lockFor = (s: Site, over: Record<string, string> = {}) =>
    JSON.stringify({ blockLibraryVersion: "0.1.0", contentHash: s.snapshot.contentHash, contractVersion: s.snapshot.contractVersion, snapshotId: s.snapshot.id, vocabularyVersion: s.snapshot.vocabularyVersion, ...over }, null, 2) + "\n";
  const treeFor = (s: Site, extra: ReturnType<typeof file>[] = [], lock?: string) => [
    file("CONTRACT.lock", lock ?? lockFor(s)),
    file("src/pages/index.astro", "---\n---\n<h1>Home</h1>\n"),
    file("vendor/webdesk-blocks.tgz", Buffer.from([0x1f, 0x8b, 8, 0])),
    ...extra,
  ];

  /** Point the mocked chokepoint at a fake repo named after the site. */
  function fakeRepoFor(s: Site): { gh: FakeGithub; base: string } {
    gh = new FakeGithub(ORG, s.slug);
    const base = gh.seedTemplate({ "README.md": "# template\n", ".github/workflows/site.yml": "name: site\n" });
    const call = gh.caller();
    vi.mocked(githubAppService.githubRequest).mockImplementation(((_t: string, role: string, _a: string, req: never) => {
      if (role !== "erp") throw new Error(`the scaffold commit must use the erp App, not ${role}`);
      return call(req);
    }) as never);
    return { gh, base };
  }

  async function stored(id: string) {
    const r = await adminPool().query(
      `SELECT scaffold_state, scaffold_manifest_sha256, scaffold_snapshot_id, scaffold_branch, scaffold_base_sha, scaffold_tree_sha,
              scaffold_commit_sha, scaffold_file_count, scaffold_total_bytes, scaffold_goal_id, scaffold_requested_by, scaffold_error,
              scaffold_committed_at
         FROM webdev_provisioned_sites WHERE id = $1`,
      [id],
    );
    return r.rows[0] as Record<string, unknown>;
  }

  async function refusal(p: Promise<unknown>): Promise<ScaffoldRefusal> {
    try {
      await p;
    } catch (err) {
      if (err instanceof ScaffoldRefusal) return err;
      throw err;
    }
    throw new Error("expected a refusal");
  }

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("P4b2 Scaffold Co", ["webdev"]);
    userId = await createUser("p4b2-operator@ex.test", "P4b2 Operator");
    await addMembership(T, userId);
    config.githubOrg = ORG;
    config.githubOrgTenantId = T;
  });

  afterAll(async () => {
    config.githubOrg = saved.org;
    config.githubOrgTenantId = saved.orgTenant;
    await teardownTestDb();
  });

  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  it("HAPPY PATH: committed, recorded, ledgered (attributed) and announced", async () => {
    const s = await completeSite();
    const { base } = fakeRepoFor(s);
    const goalId = randomUUID();
    const r = await commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, goalId, files: treeFor(s) });
    expect(r).toMatchObject({ outcome: "committed", repo: `${ORG}/${s.slug}`, branch: "main", baseSha: base, snapshotId: s.snapshot.id, fileCount: 3 });
    expect(gh.headOf()).toBe(r.commitSha);
    expect(gh.filesAt(r.commitSha).get("README.md")).toBe("# template\n");

    expect(await stored(s.id)).toMatchObject({
      scaffold_state: "committed", scaffold_snapshot_id: s.snapshot.id, scaffold_branch: "main", scaffold_base_sha: base,
      scaffold_tree_sha: r.treeSha, scaffold_commit_sha: r.commitSha, scaffold_file_count: 3, scaffold_goal_id: goalId,
      scaffold_requested_by: userId, scaffold_error: null,
    });
    expect((await stored(s.id)).scaffold_committed_at).toBeTruthy();

    const acts = await adminPool().query(
      `SELECT metadata->>'outcome' AS outcome, metadata->'attribution'->>'email' AS email, metadata->>'repo' AS repo, metadata->>'ref' AS ref
         FROM activities WHERE tenant_id = $1 AND verb = 'github.push' AND metadata->>'repo' = $2 ORDER BY occurred_at, id`,
      [T, `${ORG}/${s.slug}`],
    );
    expect(acts.rows.map((a) => a.outcome).sort()).toEqual(["attempted", "attempted", "succeeded", "succeeded"]);
    expect(acts.rows.every((a) => a.email === "p4b2-operator@ex.test" && a.ref === "refs/heads/main")).toBe(true);
    // the commit names the ledger's correlation id (§4.4)
    const attempted = acts.rows.length;
    expect(attempted).toBe(4);
    expect(gh.commits.get(r.commitSha)!.message).toMatch(/Gaiada-Activity: [0-9a-f-]{36}/);

    const ev = await adminPool().query(
      `SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'webdev.site.scaffold_committed'`,
      [s.id],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload).toMatchObject({ commitSha: r.commitSha });

    expect(await readScaffoldCommit(T, s.id)).toMatchObject({ state: "committed", commitSha: r.commitSha, branch: "main", fileCount: 3, error: null });
  });

  it("IDEMPOTENT: an identical re-submit answers from the row with no GitHub call; a different tree is refused", async () => {
    const s = await completeSite();
    fakeRepoFor(s);
    const first = await commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s) });
    const calls = vi.mocked(githubAppService.githubRequest).mock.calls.length;
    const again = await commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s).reverse() });
    expect(again).toMatchObject({ outcome: "already_committed", commitSha: first.commitSha });
    expect(vi.mocked(githubAppService.githubRequest).mock.calls.length).toBe(calls);
    const e = await refusal(commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s, [file("x.txt", "x")]) }));
    expect(e.code).toBe("scaffold_already_committed");
    expect(gh.headOf()).toBe(first.commitSha);
  });

  it("CRASH between commit created and ref updated: the row holds commit_created; the retry reuses that commit", async () => {
    const s = await completeSite();
    const { base } = fakeRepoFor(s);
    let dropped = false;
    gh.beforeRequest = (method) => {
      if (method === "PATCH" && !dropped) {
        dropped = true;
        throw new GithubApiError("PATCH ref", 0, "network_error_or_timeout");
      }
    };
    const e = await refusal(commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s) }));
    expect(e.code).toBe("github_write_failed");
    const mid = await stored(s.id);
    expect(mid).toMatchObject({ scaffold_state: "commit_created", scaffold_error: "github_write_failed", scaffold_base_sha: base });
    expect(gh.headOf()).toBe(base);

    const r = await commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s) });
    expect(r.commitSha).toBe(mid.scaffold_commit_sha);
    expect(gh.count("POST", "/git/commits")).toBe(1);
    expect(await stored(s.id)).toMatchObject({ scaffold_state: "committed", scaffold_error: null });
  });

  it("CONCURRENT: two submissions of the same tree land one commit, with one ref update", async () => {
    const s = await completeSite();
    fakeRepoFor(s);
    const [a, b] = await Promise.all([
      commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s) }),
      commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s) }),
    ]);
    expect(a.commitSha).toBe(b.commitSha);
    expect(gh.headOf()).toBe(a.commitSha);
    expect(gh.count("PATCH", "/git/refs/heads/")).toBe(1);
    expect((await stored(s.id)).scaffold_commit_sha).toBe(a.commitSha);
  });

  it("NOT PRISTINE: a human commit on the template is refused and recorded; nothing is written", async () => {
    const s = await completeSite();
    fakeRepoFor(s);
    const human = gh.pushHumanCommit({ "notes.md": "mine" });
    const e = await refusal(commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s) }));
    expect(e.code).toBe("scaffold_repo_not_pristine");
    expect(gh.headOf()).toBe(human);
    expect(await stored(s.id)).toMatchObject({ scaffold_state: null, scaffold_error: "scaffold_repo_not_pristine" });
  });

  it("SCOPE: the GH-12 repo only (approved, same name), a complete site only, the pinned snapshot only", async () => {
    const unapproved = await completeSite({ approvalStatus: "pending" });
    fakeRepoFor(unapproved);
    expect((await refusal(commitScaffoldTree(ports(unapproved.id), { siteId: unapproved.id, runId: unapproved.runId, files: treeFor(unapproved) }))).code)
      .toBe("scaffold_repo_unresolved");

    const elsewhere = await completeSite({ repoUrl: () => `https://github.com/${ORG}/someone-elses-repo` });
    fakeRepoFor(elsewhere);
    expect((await refusal(commitScaffoldTree(ports(elsewhere.id), { siteId: elsewhere.id, runId: elsewhere.runId, files: treeFor(elsewhere) }))).code)
      .toBe("scaffold_repo_unresolved");

    const halfway = await completeSite({ completion: "tenant_ready" });
    fakeRepoFor(halfway);
    expect((await refusal(commitScaffoldTree(ports(halfway.id), { siteId: halfway.id, runId: halfway.runId, files: treeFor(halfway) }))).code)
      .toBe("scaffold_site_not_complete");

    const s = await completeSite();
    fakeRepoFor(s);
    const other = await refusal(commitScaffoldTree(ports(s.id), { siteId: s.id, runId: s.runId, files: treeFor(s, [], lockFor(s, { snapshotId: newId() })) }));
    expect(other.code).toBe("scaffold_lock_snapshot_mismatch");
    const wrongRun = await refusal(commitScaffoldTree(ports(s.id), { siteId: s.id, runId: newId(), files: treeFor(s) }));
    expect(wrongRun.code).toBe("scaffold_run_mismatch");
    expect(gh.count("POST", "/git/")).toBe(0);
    // another company's site is invisible (RLS): not found, never a write
    const OTHER = await createCompany("P4b2 Other Co", ["webdev"]);
    const foreign = scaffoldCommitPorts({ tenantId: OTHER, siteId: s.id, orgTenantId: OTHER, actor: actor() });
    expect((await refusal(commitScaffoldTree(foreign, { siteId: s.id, runId: s.runId, files: treeFor(s) }))).code).toBe("not_found");
  });

  it("SCHEMA: a scaffold state needs its links and a complete site; sha columns are shape-checked", async () => {
    const s = await completeSite();
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET scaffold_state = 'pending' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    const half = await completeSite({ completion: "tenant_ready" });
    await expect(
      adminPool().query(
        `UPDATE webdev_provisioned_sites
            SET scaffold_state = 'pending', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main', scaffold_base_sha = $4
          WHERE id = $1`,
        [half.id, "a".repeat(64), half.snapshot.id, "b".repeat(40)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A NULL completion (never started) is not 'complete' either. Before 202610130110 the CHECK passed on NULL here.
    await expect(
      adminPool().query(
        `UPDATE webdev_provisioned_sites
            SET completion_state = NULL, scaffold_state = 'pending', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3,
                scaffold_branch = 'main', scaffold_base_sha = $4
          WHERE id = $1`,
        [half.id, "a".repeat(64), half.snapshot.id, "b".repeat(40)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(adminPool().query(`UPDATE webdev_provisioned_sites SET scaffold_base_sha = 'not-a-sha' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(
      adminPool().query(
        `UPDATE webdev_provisioned_sites
            SET scaffold_state = 'committed', scaffold_manifest_sha256 = $2, scaffold_snapshot_id = $3, scaffold_branch = 'main',
                scaffold_base_sha = $4, scaffold_tree_sha = $4, scaffold_commit_sha = $4
          WHERE id = $1`,
        [s.id, "a".repeat(64), s.snapshot.id, "b".repeat(40)],
      ),
    ).rejects.toMatchObject({ code: "23514" }); // committed without committed_at
  });
});
