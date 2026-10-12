// M6-P4g (docs/plans/2026-10-13-webdesk-m6-p4g-deploy-grant.md) — the GitHub calls the deploy gate needs: which repo
// this is (its numeric id), what its default branch carries at its head (`CONTRACT.lock`, through the contents API),
// and which repositories may READ an organization Actions secret.
//
//   GET    /repos/{o}/{r}                                               -> id, default_branch
//   GET    /repos/{o}/{r}/contents/{path}?ref={sha}                     -> one file at one commit (404: absent)
//   GET    /orgs/{org}/actions/secrets/{name}                           -> exists? visibility
//   PUT    /orgs/{org}/actions/secrets/{name}/repositories/{repo_id}    -> 204, idempotent
//   DELETE /orgs/{org}/actions/secrets/{name}/repositories/{repo_id}    -> 204, idempotent
//
// ── NO SECRET VALUE, EVER (WSK-D29) ───────────────────────────────────────────────────────────────
// There is deliberately no function here that reads or writes a secret's VALUE (no public-key fetch, no
// `PUT /orgs/{org}/actions/secrets/{name}` with an encrypted value). The ERP only changes which repositories may read
// a secret the org owner created. GitHub's GET of an org secret returns its name, dates and visibility, never its value.
//
// ── NO EGRESS HERE, NO CREDENTIAL HERE ────────────────────────────────────────────────────────────
// Every request goes through a `GitCaller` (git-data.ts): production binds it to `githubRequest(orgTenant, "erp", …)`,
// tests to the in-memory fake. This file holds no network call, so egress-inventory.test.ts still pins http-client.ts.
//
// ── WHAT IS AN ANSWER AND WHAT IS AN ERROR ────────────────────────────────────────────────────────
// A secret that does not exist (404) or is not set to "selected repositories" (409, or a GET showing another
// visibility) is an ANSWER about that one secret, returned as data so the caller can report it per name. Everything
// else (403 without the org-secrets permission, 5xx, the network) is thrown as GitHub's own error for the caller to
// classify. The org-secret endpoints need the App's `organization_secrets` permission (O-3).
import type { RepoRef, GitCaller } from "./git-data";
import { githubStatusOf } from "./git-data";

export interface RepoInfo {
  /** GitHub's numeric repository id, which the secret endpoints take. */
  id: number;
  defaultBranch: string;
}

/** A GitHub Actions secret name: letters, digits and underscores, not starting with a digit or `GITHUB_`. */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name) && !/^GITHUB_/i.test(name);
}

function repoPath(repo: RepoRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function secretPath(org: string, secretName: string): string {
  if (!isValidSecretName(secretName)) throw new Error(`not a valid GitHub secret name: ${JSON.stringify(secretName)}`);
  return `/orgs/${encodeURIComponent(org)}/actions/secrets/${encodeURIComponent(secretName)}`;
}

function requireRepositoryId(repositoryId: number): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error(`not a GitHub repository id: ${repositoryId}`);
  return String(repositoryId);
}

export async function getRepoInfo(call: GitCaller, repo: RepoRef): Promise<RepoInfo> {
  const r = await call<{ id?: unknown; default_branch?: unknown }>({ path: repoPath(repo) });
  const id = r.data?.id;
  const branch = r.data?.default_branch;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("GitHub returned no repository id");
  if (typeof branch !== "string" || !branch) throw new Error("GitHub returned no default branch");
  return { id, defaultBranch: branch };
}

/**
 * One file's bytes at one commit, through the contents API, or null when the path does not exist there (404) or is not
 * a regular file (a directory answers with an array, a symlink or submodule with another `type`).
 */
export async function getFileAtRef(call: GitCaller, repo: RepoRef, path: string, ref: string): Promise<Buffer | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let r;
  try {
    r = await call<unknown>({ path: `${repoPath(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}` });
  } catch (err) {
    if (githubStatusOf(err) === 404) return null;
    throw err;
  }
  const d = r.data as { type?: unknown; encoding?: unknown; content?: unknown } | unknown[] | null | undefined;
  if (!d || Array.isArray(d) || d.type !== "file") return null;
  // A file over 1 MB comes back with encoding "none" and no content; CONTRACT.lock is a few hundred bytes, so that
  // answer is treated like any other unreadable file: not a lock.
  if (d.encoding !== "base64" || typeof d.content !== "string") return null;
  return Buffer.from(d.content.replace(/\s+/g, ""), "base64");
}

export type OrgSecretVisibility = "all" | "private" | "selected";

/** The org secret's metadata (never its value), or null when it does not exist. */
export async function getOrgSecret(call: GitCaller, org: string, secretName: string): Promise<{ visibility: OrgSecretVisibility | "unknown" } | null> {
  try {
    const r = await call<{ visibility?: unknown }>({ path: secretPath(org, secretName) });
    const v = r.data?.visibility;
    return { visibility: v === "all" || v === "private" || v === "selected" ? v : "unknown" };
  } catch (err) {
    if (githubStatusOf(err) === 404) return null;
    throw err;
  }
}

export type SecretAccessResult = "granted" | "revoked" | "missing" | "not_selected";

/** Adds the repository to the secret's selected repositories. GitHub's PUT is idempotent: a repeat is a 204 too. */
export async function addRepoToOrgSecret(call: GitCaller, org: string, secretName: string, repositoryId: number): Promise<SecretAccessResult> {
  try {
    await call<unknown>({ method: "PUT", path: `${secretPath(org, secretName)}/repositories/${requireRepositoryId(repositoryId)}` });
    return "granted";
  } catch (err) {
    const s = githubStatusOf(err);
    if (s === 404) return "missing";
    if (s === 409) return "not_selected";
    throw err;
  }
}

/** Removes the repository from the secret's selected repositories. Idempotent: a repo that was not listed is a 204. */
export async function removeRepoFromOrgSecret(call: GitCaller, org: string, secretName: string, repositoryId: number): Promise<SecretAccessResult> {
  try {
    await call<unknown>({ method: "DELETE", path: `${secretPath(org, secretName)}/repositories/${requireRepositoryId(repositoryId)}` });
    return "revoked";
  } catch (err) {
    const s = githubStatusOf(err);
    if (s === 404) return "missing";
    if (s === 409) return "not_selected";
    throw err;
  }
}
