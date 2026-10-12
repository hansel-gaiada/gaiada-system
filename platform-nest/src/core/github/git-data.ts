// M6-P4b2 (docs/plans/2026-10-12-webdesk-m6-p4b2-scaffold-commit.md) — the Git Data API, as the ERP App's write
// arm needs it to put a tree on a branch without a working copy: read a branch head, a commit and a tree, create
// blobs, a tree and a commit, then fast-forward the branch.
//
//   GET   /repos/{o}/{r}                         -> default_branch
//   GET   /repos/{o}/{r}/git/ref/heads/{branch}  -> object.sha (404: no such branch)
//   GET   /repos/{o}/{r}/git/commits/{sha}       -> tree.sha, parents[]
//   GET   /repos/{o}/{r}/git/trees/{sha}?recursive=1
//   POST  /repos/{o}/{r}/git/blobs               {content (base64), encoding: "base64"}
//   POST  /repos/{o}/{r}/git/trees               {base_tree, tree: [{path, mode: "100644", type: "blob", sha}]}
//   POST  /repos/{o}/{r}/git/commits             {message, tree, parents, author, committer}
//   PATCH /repos/{o}/{r}/git/refs/heads/{branch} {sha, force: false}
//
// ── NO EGRESS HERE, NO CREDENTIAL HERE ────────────────────────────────────────────────────────────
// Every request goes through a `GitCaller`. Production binds it to `githubRequest(orgTenantId, "erp", actor, …)`
// (`erpGitCaller` below), the §4.1 chokepoint: the token is minted, cached and rate-limited there and never leaves
// it. Tests bind it to a fake GitHub. This file holds no `fetch`, so egress-inventory.test.ts still pins
// http-client.ts as the single outbound file.
//
// ── WHAT THIS FILE GUARANTEES ─────────────────────────────────────────────────────────────────────
//   * Only regular files (`100644`) are ever written. There is no parameter for a mode: a symlink, a submodule or
//     an executable cannot be expressed through this module.
//   * `fastForwardRef` sends `force: false`, always. GitHub then refuses (422) any update that is not a fast forward,
//     so a branch that moved after the caller read it can never be overwritten.
//   * `createBlob` returns GitHub's sha and the caller compares it to `gitBlobSha` of the bytes it verified, so
//     what lands is provably what was checked.
// What it does NOT decide: which repo, which branch, whether the write is allowed. That is the caller's
// (modules/webdev/scaffold-commit*.ts), after Cerbos.
import { createHash } from "node:crypto";
import type { GithubRequest, GithubResponse } from "./http-client";
import { GithubApiError } from "./errors";
import { githubRequest } from "./github-app.service";

/** One authenticated GitHub call. The role is fixed by whoever builds it (`erpGitCaller`). */
export type GitCaller = <T>(req: Omit<GithubRequest, "role">) => Promise<GithubResponse<T>>;

/** The production caller: the ERP (write) App, under the GitHub org tenant, in `actorId`'s fairness slot. */
export function erpGitCaller(orgTenantId: string, actorId: string): GitCaller {
  return <T>(req: Omit<GithubRequest, "role">) => githubRequest<T>(orgTenantId, "erp", actorId, req);
}

export interface RepoRef {
  owner: string;
  name: string;
}

export interface GitIdentity {
  name: string;
  email: string;
  /** ISO-8601. */
  date: string;
}

export interface GitCommitInfo {
  sha: string;
  treeSha: string;
  parents: string[];
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

/** Git's object id for a blob: sha1("blob <size>\0" + bytes), lowercase hex. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** The HTTP status GitHub answered, from a `GithubApiError` (its `detail.httpStatus`), or null. */
export function githubStatusOf(err: unknown): number | null {
  if (!(err instanceof GithubApiError)) return null;
  const s = (err.detail as { httpStatus?: unknown } | undefined)?.httpStatus;
  return typeof s === "number" ? s : null;
}

const SHA_RE = /^[0-9a-f]{40}$/;

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** A branch name may contain `/`; each segment is encoded, the separators are kept. */
function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function requireSha(value: unknown, what: string): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error(`GitHub returned no valid ${what} sha`);
  return value;
}

export async function getDefaultBranch(call: GitCaller, repo: RepoRef): Promise<string> {
  const r = await call<{ default_branch?: unknown }>({ path: repoPath(repo) });
  const b = r.data?.default_branch;
  if (typeof b !== "string" || !b) throw new Error("GitHub returned no default branch");
  return b;
}

/** The commit a branch points at, or null when the branch does not exist (404). */
export async function getBranchHead(call: GitCaller, repo: RepoRef, branch: string): Promise<string | null> {
  try {
    const r = await call<{ object?: { sha?: unknown; type?: unknown } }>({
      path: `${repoPath(repo)}/git/ref/heads/${branchPath(branch)}`,
    });
    return requireSha(r.data?.object?.sha, "branch head");
  } catch (err) {
    if (githubStatusOf(err) === 404) return null;
    throw err;
  }
}

export async function getCommit(call: GitCaller, repo: RepoRef, sha: string): Promise<GitCommitInfo> {
  const r = await call<{ sha?: unknown; tree?: { sha?: unknown }; parents?: Array<{ sha?: unknown }> }>({
    path: `${repoPath(repo)}/git/commits/${encodeURIComponent(sha)}`,
  });
  return {
    sha: requireSha(r.data?.sha, "commit"),
    treeSha: requireSha(r.data?.tree?.sha, "tree"),
    parents: (r.data?.parents ?? []).map((p) => requireSha(p?.sha, "parent")),
  };
}

/** Every entry of a tree, recursively. `truncated` is GitHub's own flag (very large trees). */
export async function getTreeRecursive(
  call: GitCaller,
  repo: RepoRef,
  treeSha: string,
): Promise<{ entries: GitTreeEntry[]; truncated: boolean }> {
  const r = await call<{ tree?: Array<{ path?: unknown; mode?: unknown; type?: unknown; sha?: unknown }>; truncated?: unknown }>({
    path: `${repoPath(repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
  });
  const entries: GitTreeEntry[] = [];
  for (const e of r.data?.tree ?? []) {
    if (typeof e.path !== "string" || typeof e.mode !== "string" || typeof e.sha !== "string") continue;
    if (e.type !== "blob" && e.type !== "tree" && e.type !== "commit") continue;
    entries.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha });
  }
  return { entries, truncated: r.data?.truncated === true };
}

/** Uploads one blob and returns GitHub's sha for it. The caller compares it to `gitBlobSha(bytes)`. */
export async function createBlob(call: GitCaller, repo: RepoRef, bytes: Buffer): Promise<string> {
  const r = await call<{ sha?: unknown }>({
    method: "POST",
    path: `${repoPath(repo)}/git/blobs`,
    body: { content: bytes.toString("base64"), encoding: "base64" },
  });
  return requireSha(r.data?.sha, "blob");
}

/** One tree on top of `baseTree`: every entry is a regular file (`100644`). */
export async function createTree(
  call: GitCaller,
  repo: RepoRef,
  baseTree: string,
  entries: ReadonlyArray<{ path: string; sha: string }>,
): Promise<string> {
  const r = await call<{ sha?: unknown }>({
    method: "POST",
    path: `${repoPath(repo)}/git/trees`,
    body: {
      base_tree: baseTree,
      tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha })),
    },
  });
  return requireSha(r.data?.sha, "tree");
}

export async function createCommit(
  call: GitCaller,
  repo: RepoRef,
  input: { message: string; tree: string; parents: string[]; author: GitIdentity; committer: GitIdentity },
): Promise<string> {
  const r = await call<{ sha?: unknown }>({
    method: "POST",
    path: `${repoPath(repo)}/git/commits`,
    body: {
      message: input.message,
      tree: input.tree,
      parents: input.parents,
      author: input.author,
      committer: input.committer,
    },
  });
  return requireSha(r.data?.sha, "commit");
}

export type FastForwardResult = { outcome: "updated" } | { outcome: "not_fast_forward" };

/**
 * Moves `branch` to `sha`, fast-forward only (`force: false`). GitHub answers 422 when the branch has moved to
 * something `sha` does not descend from: that is `not_fast_forward`, never retried and never forced.
 */
export async function fastForwardRef(call: GitCaller, repo: RepoRef, branch: string, sha: string): Promise<FastForwardResult> {
  try {
    await call<unknown>({
      method: "PATCH",
      path: `${repoPath(repo)}/git/refs/heads/${branchPath(branch)}`,
      body: { sha, force: false },
    });
    return { outcome: "updated" };
  } catch (err) {
    if (githubStatusOf(err) === 422) return { outcome: "not_fast_forward" };
    throw err;
  }
}
