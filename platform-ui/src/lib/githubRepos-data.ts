import "server-only";
// GH-09 — Sites/Repos registry reader. Consumes GH-08's BFF (docs/FRONTEND-BFF-CONTRACT.md §25,
// confirmed against the live `GithubReposController` — `GET /api/:t/github/repos`, response
// `{ repos, total, limit, offset, org }`).
//
// ── §25's OWN FLAGGED STATE: EVERY ROUTE 403s FOR EVERY PRINCIPAL TODAY, INCLUDING platform_admin ──
// GH-03 (the Cerbos policy for the `github_repo` resource kind) has not shipped — `resource_github_
// repo.yaml` does not exist, so `check()` gets no verdict for this kind and treats it as DENY. That
// is fail-closed BY DESIGN, not a bug this file should route around. The consequence for this reader
// is that `refused` is the expected, common outcome right now, not an edge case — and per the
// "empty list is a claim" convention (root MEMORY.md) it must never be coalesced into `{ok:true,
// repos:[]}`. A 403 renders ReadRefusal; a genuinely empty, AUTHORIZED read renders EmptyNote. The
// two are never allowed to look the same on screen.
//
// ── GHT-3: A THIRD FAILURE STATE, "NO ORG" — SEE `classifyGithubOrgUnavailable` BELOW ────────────
// GHT-1's resolver (`platform-nest/src/core/github-org-tenant.ts::resolveGithubOrgTenant`) refuses
// with a 503 `ServiceUnavailableException` whenever there is no reachable org tenant to ask Cerbos
// about at all — either the `GITHUB_REPO_SYNC_TENANT_ID` knob is unset, or the URL tenant sits in a
// different root. That is a DIFFERENT fact than "unavailable" (endpoint unreachable / real outage)
// and must render as its own honest state — an operator reading "backend unreachable, try again
// later" for a config gap that will NEVER resolve on retry is the exact confident-wrong-answer this
// whole ticket exists to stop. See `classifyGithubOrgUnavailable`'s own comment for exactly how (and
// why fragilely) that 503 is told apart from any other one, and where the one-line fix goes once the
// architect settles the ruling's §8/§9 open question (distinct status/body for no-org vs an actual
// 503 outage). `githubOrgStatus-data.ts` (GHT-2's reader) imports this SAME function rather than
// duplicating the mapping — there must be exactly one place to change.
import { platformFetch, PlatformError } from "./platform";
import type { GithubRepoListParams, GithubRepoListResponse } from "./githubRepos";

export type ListGithubReposResult =
  | { ok: true; data: GithubRepoListResponse }
  | {
      ok: false;
      /** `refused` — Cerbos denied the read (see the file-header note: this is the expected
       *  outcome until GH-03 ships). `no_org` — GHT-1 could not resolve a reachable org tenant at
       *  all (unset config, or a different root) — a configuration/tenancy fact, not an outage.
       *  `unavailable` — anything else (404/500/network, or a 503 that isn't the no-org shape): the
       *  endpoint cannot be reached right now. None of the three is ever rendered as "zero repos". */
      reason: "refused" | "no_org" | "unavailable";
    };

// ── THE ONE PLACE THIS MAPPING LIVES (pending architect call, ruling §8/§9) ─────────────────────
// Today GHT-1/GHT-2 signal "no org tenant configured" via a 503 with one of exactly two message
// strings (`github-org-tenant.ts::throwGithubOrgUnavailable`) — sniffed here by CONTENT, not status
// code alone, precisely because 503 is not (yet) reserved for this meaning: the ticket instruction
// is explicit that a future architect decision may give reads a distinct status/code for "no org"
// while writes keep 503, and this function must not have hard-coded "503 == no org" anywhere. If
// that lands, this is the ONLY function that changes — swap the body for whatever the new signal is
// (a header, a `{ reason: "no_org" }` JSON field, a non-503 status) and every caller (this file,
// `githubOrgStatus-data.ts`) picks it up for free.
const NO_ORG_MESSAGE_FRAGMENTS = [
  "github org tenant misconfigured",
  "no github org registered for this company",
];
export function classifyGithubOrgUnavailable(e: PlatformError): boolean {
  if (e.status !== 503) return false;
  const msg = e.message.toLowerCase();
  return NO_ORG_MESSAGE_FRAGMENTS.some((fragment) => msg.includes(fragment));
}

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
    if (e instanceof PlatformError && classifyGithubOrgUnavailable(e)) return { ok: false, reason: "no_org" };
    if (e instanceof PlatformError) return { ok: false, reason: "unavailable" };
    throw e;
  }
}
