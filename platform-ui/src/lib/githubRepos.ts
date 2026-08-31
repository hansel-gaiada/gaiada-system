// GH-09 — Sites/Repos registry. Client-safe types + pure, zero-I/O helpers (module-trio "X.ts",
// see platform-ui/CLAUDE.md) for `GithubRepoView`, the shape GH-08's BFF returns —
// docs/FRONTEND-BFF-CONTRACT.md §25, confirmed field-for-field against the live controller
// (`platform-nest/src/core/github-repos.controller.ts`'s `REPO_VIEW_COLUMNS`, read for names/
// types — not edited; that file is GH-08's, out of this ticket's scope). Design:
// docs/blueprints/github-integration-foundation.md §5.2 (the underlying `github_repos` schema)
// and §5.4 (the surface this file's helpers exist to serve).

export type RepoVisibility = "public" | "private" | "internal";

/** One row of the list/detail response — §25's `GithubRepoView`, one shape for both. Every
 *  "GitHub fact" column the migration deliberately left un-CHECK-constrained (visibility aside)
 *  stays `string | null` here too: GitHub owns that vocabulary, not this UI. */
export interface GithubRepoView {
  id: string;

  // identity
  org: string;
  name: string;
  fullName: string;
  htmlUrl: string;

  // GitHub facts
  visibility: RepoVisibility;
  archived: boolean;
  topics: string[];

  // source state — nullable: GitHub itself returns null head facts for a created-never-pushed repo
  defaultBranch: string;
  headSha: string | null;
  headCommittedAt: string | null;
  headAuthor: string | null; // free-form "Name <email>", as GitHub's commit API gives it

  // CI state — free text, no CHECK (GitHub's own vocabulary)
  openPrCount: number;
  latestRunStatus: string | null;
  latestRunConclusion: string | null;
  latestRunAt: string | null;

  // release state
  latestReleaseTag: string | null;
  /** Free-text pointer (e.g. a deploy-workflows artifact branch) — NOT guaranteed to be a SHA, see
   *  deployedRefStatus() below. ⚠ As of GH-06 (the initial crawl), this is NULL for every row: the
   *  deployed ref lives in `deploy-workflows`' artifact-branch state, a webhook concern for GH-07,
   *  which has not shipped. The column and this field exist; nothing populates them yet. Render a
   *  null value as UNKNOWN, never as a computed verdict — see deployedRefStatus()'s own comment. */
  deployedRef: string | null;

  // the ERP link (§25: "both null when unlinked") — a LEFT JOIN'd display name alongside each id,
  // so this UI can render "which site/project" without a second round trip or a fabricated label.
  webdevSiteId: string | null;
  webdevSiteDomain: string | null;
  projectId: string | null;
  projectName: string | null;

  // freshness
  repoCreatedAt: string;
  pushedAt: string | null;
  /** Defensively `| null | undefined` even though the column is `NOT NULL DEFAULT now()` on the
   *  backend — "a missing field reads exactly like NULL" (root MEMORY.md) is this estate's own
   *  recurring bug class, and this is the one field this whole surface exists to keep honest about. */
  lastSyncedAt: string | null | undefined;

  createdAt: string;
  updatedAt: string;
}

/** `GET /api/:t/github/repos` response envelope (§25) — never a bare array. `total` is a real
 *  `COUNT(*)` against the same filter predicate, independent of how many rows this page carries,
 *  so a bucket-size chip can read it directly even when the page is truncated by `limit`. */
export interface GithubRepoListResponse {
  repos: GithubRepoView[];
  total: number;
  limit: number;
  offset: number;
}

/** Query params the list endpoint accepts (§25's "List filters"). Booleans are sent as the literal
 *  strings `"true"`/`"false"` — the controller rejects anything else with a 400 — and OMITTING a
 *  filter means "no predicate on that column", not a default value the backend picks for you. See
 *  lib/githubRepos-data.ts for how this UI uses that (the archived toggle omits the param entirely
 *  to mean "both states", rather than guessing which single value "unfiltered" should map to). */
export interface GithubRepoListParams {
  linked?: boolean;
  archived?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

// ── Unlinked bucket (§5.4: "unlinked repos as their own bucket") ───────────────────────────────────
// The backend now does this filtering server-side (`linked=false`, §25) — these helpers stay for
// the client-side cases that still need the predicate: computing whether a directly-fetched row IS
// unlinked (independent of which server query produced it), and for tests.
export function isUnlinked(repo: Pick<GithubRepoView, "webdevSiteId" | "projectId">): boolean {
  return !repo.webdevSiteId && !repo.projectId;
}

// ── Sync freshness (§5.2: "a stale row must be VISIBLY stale") ─────────────────────────────────────
// No server-computed freshness state exists in `GithubRepoView` (unlike Plane A's HostFreshness,
// lib/observability.ts, which the observability backend computes server-side) — this is a CLIENT
// judgement call against `lastSyncedAt` alone, thresholded against §5.3's description of the sync
// strategy: webhooks keep most rows near-live, and a periodic reconcile sweep bounds the gap for
// anything webhooks missed. `fresh` <= 24h (inside one webhook/reconcile cycle), `stale` <= 7 days
// (the sweep's presumed outer bound — no cadence is documented yet, so this is conservative on
// purpose), beyond that `dark`: old enough that the sync machinery itself is worth checking, not
// just this one repo. `unknown` only if the field is missing/unparseable.
export type RepoSyncFreshness = "fresh" | "stale" | "dark" | "unknown";

const FRESH_MAX_MS = 24 * 3600_000;
const STALE_MAX_MS = 7 * 24 * 3600_000;

export function syncFreshness(lastSyncedAt: string | null | undefined, nowMs: number): RepoSyncFreshness {
  if (!lastSyncedAt) return "unknown";
  const t = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(t)) return "unknown";
  const age = nowMs - t;
  if (age <= FRESH_MAX_MS) return "fresh"; // covers age < 0 (clock skew) too — never alarm on that
  if (age <= STALE_MAX_MS) return "stale";
  return "dark";
}

export const FRESHNESS_LABEL: Record<RepoSyncFreshness, string> = {
  fresh: "Synced",
  stale: "Stale",
  dark: "Sync overdue",
  unknown: "Never synced",
};

// ── Deployed ref vs head (§5.4) ─────────────────────────────────────────────────────────────────
// `deployedRef` is documented (migration comment) as "e.g. a deploy-workflows artifact branch" —
// free text, not guaranteed to be a commit SHA. There is no commit-graph distance data anywhere in
// this row, so "ahead/behind by N commits" would be fabricated. The only honest comparison is exact
// string equality against `headSha`; anything else is reported as "differs", not ranked.
//
// ⚠ GH-06 finding: `deployedRef` is NULL for every row today (GH-07's webhook ingestion, which would
// populate it from deploy-workflows' artifact-branch state, has not shipped). A null value is
// therefore NOT evidence of "no deploy" — it is an absent fact, and this is the estate's own
// recurring trap ("a missing field reads exactly like NULL", root MEMORY.md). `unknown` is the
// honest label for that null case; a naive `!deployedRef` read as "no deploy on file" would print a
// confident false claim on all 221 rows, and a naive `deployedRef === headSha` would print "behind"
// on all 221 for the same underlying reason (a `null !== headSha` compare "succeeds").
export type DeployHeadStatus = "unknown" | "matches_head" | "differs" | "no_head";

export function deployedRefStatus(repo: Pick<GithubRepoView, "deployedRef" | "headSha">): DeployHeadStatus {
  if (!repo.headSha) return "no_head"; // empty repo — nothing to compare against
  if (!repo.deployedRef) return "unknown"; // not "no deploy" — this field simply isn't populated yet
  return repo.deployedRef === repo.headSha ? "matches_head" : "differs";
}

export const DEPLOY_HEAD_LABEL: Record<DeployHeadStatus, string> = {
  unknown: "Not tracked yet",
  matches_head: "Matches head",
  differs: "Differs from head",
  no_head: "No commits yet",
};

// ── CI run state ─────────────────────────────────────────────────────────────────────────────────
// GitHub Actions' status/conclusion vocab, verbatim, no CHECK — so this label function must degrade
// honestly for a token it has never seen, never guess.
function humanizeToken(s: string): string {
  const t = s.replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

export function runLabel(status: string | null, conclusion: string | null): string {
  if (!status) return "No CI runs on file";
  if (status !== "completed") return humanizeToken(status); // in_progress | queued | waiting | ...
  return conclusion ? humanizeToken(conclusion) : humanizeToken(status);
}

/** Presentation tier shared by run state and sync freshness — kept LOCAL to this domain rather than
 *  extending the shared `STATUS_FAMILY` map in components/ui.tsx (same reasoning
 *  components/webdesk/DegradeBanner.tsx already used for its own domain-specific tones: a shared,
 *  widely-imported central map is a bad place to add several new tokens under time pressure while
 *  other tickets are touching it concurrently). Names match this app's own
 *  `--status-{ok,progress,critical,idle}[-fg]` token family exactly, so callers can build a CSS var
 *  name directly (`--status-${tone}`) without a translation table. */
export type Tone = "ok" | "progress" | "critical" | "idle";

export function runTone(status: string | null, conclusion: string | null): Tone {
  if (!status) return "idle";
  if (status !== "completed") return "progress"; // in flight — informative, not alarming
  switch (conclusion) {
    case "success":
      return "ok";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "critical";
    default:
      return "idle"; // cancelled | skipped | neutral | stale | an unseen future token
  }
}

export function freshnessTone(f: RepoSyncFreshness): Tone {
  switch (f) {
    case "fresh":
      return "ok";
    case "stale":
      return "progress";
    case "dark":
      return "critical";
    default:
      return "idle";
  }
}

// ── Commit author display ───────────────────────────────────────────────────────────────────────
/** `headAuthor` arrives as GitHub's raw commit-author string, "Name <email>". Strip the email for
 *  display — the email is not the interesting part on a registry row, and leaving it in doubles the
 *  cell width on every row. Falls back to the raw string if it doesn't match that shape, and never
 *  fabricates a name when the field is null (an empty repo has no commit, so no author). */
export function formatCommitAuthor(headAuthor: string | null): string {
  if (!headAuthor) return "—";
  const m = headAuthor.match(/^(.*?)\s*<[^<>]*>\s*$/);
  return (m ? m[1] : headAuthor).trim() || "—";
}

/** The ERP-link display name (§25's `webdevSiteDomain`/`projectName`), for a row already known to
 *  be linked. Prefers the site's domain (what an operator recognizes on sight) over the project
 *  name when a repo carries both links; falls back to a generic "(unnamed)" only if the id is set
 *  but the LEFT JOIN found no matching row (a dangling link — worth surfacing honestly, not hiding). */
export function linkDisplayName(repo: Pick<GithubRepoView, "webdevSiteId" | "webdevSiteDomain" | "projectId" | "projectName">): string | null {
  if (repo.webdevSiteId) return repo.webdevSiteDomain ?? "(site — name unavailable)";
  if (repo.projectId) return repo.projectName ?? "(project — name unavailable)";
  return null;
}

// ── Search text (for SearchableTable / client-side filter over an already-fetched page) ────────────
export function repoSearchText(r: GithubRepoView): string {
  return [
    r.fullName, r.name, r.org, r.defaultBranch,
    formatCommitAuthor(r.headAuthor),
    r.latestRunStatus ?? "", r.latestRunConclusion ?? "",
    r.visibility, r.archived ? "archived" : "active",
    linkDisplayName(r) ?? "",
    ...r.topics,
  ].join(" ");
}
