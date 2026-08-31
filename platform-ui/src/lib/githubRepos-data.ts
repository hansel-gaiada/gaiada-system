import "server-only";
// GH-09 — Sites/Repos registry reader. Consumes GH-08's BFF (docs/FRONTEND-BFF-CONTRACT.md §25,
// confirmed against the live `GithubReposController` — `GET /api/:t/github/repos`, response
// `{ repos, total, limit, offset }`).
//
// ── §25's OWN FLAGGED STATE: EVERY ROUTE 403s FOR EVERY PRINCIPAL TODAY, INCLUDING platform_admin ──
// GH-03 (the Cerbos policy for the `github_repo` resource kind) has not shipped — `resource_github_
// repo.yaml` does not exist, so `check()` gets no verdict for this kind and treats it as DENY. That
// is fail-closed BY DESIGN, not a bug this file should route around. The consequence for this reader
// is that `refused` is the expected, common outcome right now, not an edge case — and per the
// "empty list is a claim" convention (root MEMORY.md) it must never be coalesced into `{ok:true,
// repos:[]}`. A 403 renders ReadRefusal; a genuinely empty, AUTHORIZED read renders EmptyNote. The
// two are never allowed to look the same on screen.
import { platformFetch, PlatformError } from "./platform";
import type { GithubRepoListParams, GithubRepoListResponse } from "./githubRepos";

export type ListGithubReposResult =
  | { ok: true; data: GithubRepoListResponse }
  | {
      ok: false;
      /** `refused` — Cerbos denied the read (see the file-header note: this is the expected
       *  outcome until GH-03 ships). `unavailable` — anything else (404/500/network): the endpoint
       *  cannot be reached right now. Neither is ever rendered as "zero repos". */
      reason: "refused" | "unavailable";
    };

function buildQuery(params: GithubRepoListParams): string {
  const qs = new URLSearchParams();
  // `linked`/`archived` are sent ONLY when the caller actually wants to filter on that axis —
  // omitting the param is how §25's "no predicate on that column" (both states) is requested; a
  // `false`-but-included boolean would wrongly narrow to "linked repos only" / "active repos only".
  if (params.linked !== undefined) qs.set("linked", String(params.linked));
  if (params.archived !== undefined) qs.set("archived", String(params.archived));
  if (params.search?.trim()) qs.set("search", params.search.trim());
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export async function listGithubRepos(
  userId: string,
  tenant: string,
  params: GithubRepoListParams = {},
): Promise<ListGithubReposResult> {
  try {
    const data = await platformFetch<GithubRepoListResponse>(
      `/api/${tenant}/github/repos${buildQuery(params)}`,
      userId,
    );
    return { ok: true, data };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { ok: false, reason: "refused" };
    if (e instanceof PlatformError) return { ok: false, reason: "unavailable" };
    throw e;
  }
}
