// M6-P4b2 — the Git Data API driver against a fake GitHub (git-data.testkit.ts), plus the production binding:
// `erpGitCaller` must route every call through `githubRequest(orgTenant, "erp", actor, …)`, the §4.1 chokepoint, and
// nothing else. No network.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as githubAppService from "./github-app.service";
import { GithubApiError } from "./errors";
import {
  createBlob, createCommit, createTree, erpGitCaller, fastForwardRef, getBranchHead, getCommit, getDefaultBranch,
  getTreeRecursive, gitBlobSha, githubStatusOf,
} from "./git-data";
import { FakeGithub } from "./git-data.testkit";

vi.mock("./github-app.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-app.service")>();
  return { ...actual, githubRequest: vi.fn() };
});

const who = { name: "Ops Person", email: "ops@example.test", date: "2026-10-12T00:00:00.000Z" };

describe("gitBlobSha", () => {
  it("is git's own blob id (`git hash-object`)", () => {
    expect(gitBlobSha(Buffer.from("hello"))).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
    expect(gitBlobSha(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

describe("erpGitCaller", () => {
  // A block body on purpose: a function RETURNED from beforeEach is a cleanup hook, and mockReset() returns the mock,
  // so vitest would call githubRequest with no arguments after every test.
  beforeEach(() => {
    vi.mocked(githubAppService.githubRequest).mockReset();
  });

  it("goes through githubRequest with the ERP role, the org tenant and the actor, nothing else", async () => {
    vi.mocked(githubAppService.githubRequest).mockResolvedValue({ data: { default_branch: "main" }, status: 200, rateLimit: { limit: null, remaining: null, resetAtMs: null } } as never);
    const call = erpGitCaller("org-tenant", "user-1");
    expect(await getDefaultBranch(call, { owner: "acme-org", name: "acme-site" })).toBe("main");
    expect(githubAppService.githubRequest).toHaveBeenCalledWith("org-tenant", "erp", "user-1", { path: "/repos/acme-org/acme-site" });
  });
});

describe("Git Data API driver (fake GitHub)", () => {
  let gh: FakeGithub;
  const repo = { owner: "acme-org", name: "acme-site" };
  beforeEach(() => {
    gh = new FakeGithub(repo.owner, repo.name);
  });

  it("reads the default branch, its head, the head commit and its tree (directories listed too)", async () => {
    const root = gh.seedTemplate({ "README.md": "# t\n", "src/pages/index.astro": "---\n---\n" });
    const call = gh.caller();
    expect(await getDefaultBranch(call, repo)).toBe("main");
    expect(await getBranchHead(call, repo, "main")).toBe(root);
    const c = await getCommit(call, repo, root);
    expect(c).toMatchObject({ sha: root, parents: [] });
    const t = await getTreeRecursive(call, repo, c.treeSha);
    expect(t.truncated).toBe(false);
    expect(t.entries.map((e) => `${e.type}:${e.path}`).sort()).toEqual(["blob:README.md", "blob:src/pages/index.astro", "tree:src", "tree:src/pages"]);
  });

  it("a missing branch is null, not an error; another error propagates", async () => {
    gh.seedTemplate({ a: "1" });
    expect(await getBranchHead(gh.caller(), repo, "nope")).toBeNull();
    // A repo the App cannot see answers 404 to everything: the head read maps 404 to null only for the ref itself.
    await expect(getDefaultBranch(gh.caller(), { owner: "acme-org", name: "other" })).rejects.toBeInstanceOf(GithubApiError);
  });

  it("encodes each branch segment and keeps the separators", async () => {
    gh.seedTemplate({ a: "1" }, "release/v1");
    expect(await getBranchHead(gh.caller(), repo, "release/v1")).toBe(gh.headOf("release/v1"));
    expect(gh.calls.at(-1)?.path).toBe("/repos/acme-org/acme-site/git/ref/heads/release/v1");
  });

  it("createBlob returns the git blob id of the bytes (base64 on the wire)", async () => {
    gh.seedTemplate({ a: "1" });
    const bytes = Buffer.from([0, 1, 2, 250, 251]);
    expect(await createBlob(gh.caller(), repo, bytes)).toBe(gitBlobSha(bytes));
    expect(gh.calls.at(-1)?.body).toEqual({ content: bytes.toString("base64"), encoding: "base64" });
  });

  it("createTree writes regular files only, on base_tree; createCommit sets parents, author and committer", async () => {
    const root = gh.seedTemplate({ "README.md": "# t\n" });
    const call = gh.caller();
    const base = await getCommit(call, repo, root);
    const blob = await createBlob(call, repo, Buffer.from("hi"));
    const tree = await createTree(call, repo, base.treeSha, [{ path: "src/x.txt", sha: blob }]);
    const treeBody = gh.calls.at(-1)?.body as { base_tree: string; tree: Array<Record<string, string>> };
    expect(treeBody.base_tree).toBe(base.treeSha);
    expect(treeBody.tree).toEqual([{ path: "src/x.txt", mode: "100644", type: "blob", sha: blob }]);
    const sha = await createCommit(call, repo, { message: "m", tree, parents: [root], author: who, committer: who });
    expect(gh.commits.get(sha)).toMatchObject({ tree, parents: [root], author: who, committer: who });
    expect(gh.filesAt(sha)).toEqual(new Map([["README.md", "# t\n"], ["src/x.txt", "hi"]]));
  });

  it("fastForwardRef sends force:false; a non-fast-forward is reported, never forced", async () => {
    const root = gh.seedTemplate({ a: "1" });
    const call = gh.caller();
    const base = await getCommit(call, repo, root);
    const blob = await createBlob(call, repo, Buffer.from("2"));
    const tree = await createTree(call, repo, base.treeSha, [{ path: "b", sha: blob }]);
    const ours = await createCommit(call, repo, { message: "ours", tree, parents: [root], author: who, committer: who });

    const human = gh.pushHumanCommit({ c: "3" });
    expect(await fastForwardRef(call, repo, "main", ours)).toEqual({ outcome: "not_fast_forward" });
    expect(gh.calls.at(-1)).toMatchObject({ method: "PATCH", path: "/repos/acme-org/acme-site/git/refs/heads/main", body: { sha: ours, force: false } });
    expect(gh.headOf()).toBe(human);

    const g2 = new FakeGithub(repo.owner, repo.name);
    const r2 = g2.seedTemplate({ a: "1" });
    const c2 = await getCommit(g2.caller(), repo, r2);
    const b2 = await createBlob(g2.caller(), repo, Buffer.from("2"));
    const t2 = await createTree(g2.caller(), repo, c2.treeSha, [{ path: "b", sha: b2 }]);
    const o2 = await createCommit(g2.caller(), repo, { message: "ours", tree: t2, parents: [r2], author: who, committer: who });
    expect(await fastForwardRef(g2.caller(), repo, "main", o2)).toEqual({ outcome: "updated" });
    expect(g2.headOf()).toBe(o2);
  });

  it("githubStatusOf reads GitHub's own status from a GithubApiError, nothing else", () => {
    expect(githubStatusOf(new GithubApiError("x", 422, "no"))).toBe(422);
    expect(githubStatusOf(new GithubApiError("x", 503))).toBe(503);
    expect(githubStatusOf(new Error("x"))).toBeNull();
  });
});
