import "server-only";
// GHT-2 reader (docs/blueprints/github-tenant-scope-ruling.md §3/§9) — `GET /api/:t/github/
// org-status`. Same resolve -> authorize -> read order as `github-repos.controller.ts`'s other
// routes (see the backend file's own header), so this reader mirrors `listGithubRepos`'s three-state
// shape exactly: `refused` (Cerbos denied `github_repo read` at the resolved org tenant), `no_org`
// (GHT-1 could not resolve a reachable org tenant at all), `unavailable` (anything else).
//
// `classifyGithubOrgUnavailable` is imported from `githubRepos-data.ts` rather than re-implemented
// here — see that file's own comment for why the no-org/503 mapping must live in exactly ONE place
// (a pending architect call may replace the message-content sniff with a distinct status/code, and
// this reader must pick that up for free the moment `githubRepos-data.ts` does).
import { platformFetch, PlatformError } from "./platform";
import type { GithubOrgStatus } from "./githubOrgStatus";
import { classifyGithubOrgUnavailable } from "./githubRepos-data";

export type GetGithubOrgStatusResult =
  | { ok: true; data: GithubOrgStatus }
  | {
      ok: false;
      /** See `ListGithubReposResult`'s own doc comment (githubRepos-data.ts) — identical three-way
       *  split, same reasoning, same "never render as a healthy-but-empty status" rule. */
      reason: "refused" | "no_org" | "unavailable";
    };

export async function getGithubOrgStatus(userId: string, tenant: string): Promise<GetGithubOrgStatusResult> {
  try {
    const data = await platformFetch<GithubOrgStatus>(`/api/${tenant}/github/org-status`, userId);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) return { ok: false, reason: "refused" };
    if (e instanceof PlatformError && classifyGithubOrgUnavailable(e)) return { ok: false, reason: "no_org" };
    if (e instanceof PlatformError) return { ok: false, reason: "unavailable" };
    throw e;
  }
}
