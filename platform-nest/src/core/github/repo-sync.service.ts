// GH-06 (docs/blueprints/github-integration-foundation.md §5.3) — the initial org crawl AND the
// periodic reconcile sweep that populate `github_repos` (GH-05, migration 202608310735). One
// function serves both jobs: §5.3 lists them as two work items, but the blueprint's own reasoning
// for the sweep ("webhooks are not reliable delivery... a registry that trusts them alone will
// silently diverge") describes exactly the same operation — full-org enumeration, upsert — run
// again later. The FIRST call a fresh tenant ever gets IS the initial crawl; every call after that
// IS the reconcile sweep. Splitting them into two functions would only duplicate the pagination +
// upsert logic for no behavioural difference.
//
// ── BUILDS ON THE GH-01/GH-02 CHOKEPOINT, DOES NOT REBUILD IT ──────────────────────────────────
// Every GitHub call here goes through `githubRequest()` (github-app.service.ts) — the ONE function
// "every future GH ticket... should call" per that file's own header. This module never touches
// fetch, the rate limiter, the token cache, or credential-store.ts directly.
//
// ── NO TENANT-RESOLUTION LOGIC HERE (BY RULING) ────────────────────────────────────────────────
// §5.2's GAP-CLOSED ruling: "tenant_id = the operating company that owns the GitHub org, always...
// which also means the sync job needs no tenant-resolution logic at all." This file takes
// `tenantId` as a plain parameter and never guesses it — the CALLER (config.githubRepoSync +
// main.ts's loop starter, below) resolves it once from an env var, matching §2.3's "every function
// still takes tenantId as a parameter... the ruling says which value callers pass" precedent for
// the exact same question one layer down (which tenant owns the App credential row).
//
// ── NO `org` PARAMETER EITHER — DERIVED FROM WHAT GITHUB RETURNS ───────────────────────────────
// `org` is not asked for; it is read off each repo's own `full_name` (`org/name`), exactly as §5.1
// mandates ("GitHub is truth for repo facts"). This also means a second org showing up under the
// same installation (not expected today, not forbidden by the schema either — see the migration's
// own "why org is not CHECK-constrained" note) is reconciled correctly with zero code changes.
//
// ── IDEMPOTENT UPSERT, LINK COLUMNS NEVER TOUCHED ──────────────────────────────────────────────
// The UPDATE arm of the upsert explicitly excludes `tenant_id`, `webdev_site_id`, `project_id`,
// `deployed_ref`, `created_at`, `deleted_at` and `origin_site` from its SET list. `webdev_site_id`/
// `project_id` are the ERP-owned link (§5.1: "the ERP is truth for the link to a site/project" —
// this sync must never invert that). `deployed_ref` has no source in THIS ticket's scope (it comes
// from the deploy-workflows artifact-branch state, a later ticket's job) — leaving it out of both
// the INSERT and UPDATE column lists means a future writer's value is never stomped back to NULL by
// a sweep that runs after it.
//
// ── SOFT-DELETE RECONCILE: THE OTHER HALF OF "DETECTS DRIFT" ──────────────────────────────────
// A repo can leave the installation's visible set (deleted upstream, transferred out of the org, or
// the App's per-repo access revoked) without ever sending a webhook the receiver would catch. After
// each successful full enumeration, any LIVE row for an org this crawl actually saw, whose
// full_name was NOT in the fetched set, is soft-deleted (`deleted_at = now()`) — never hard-deleted,
// preserving history for audit. Guarded: if the installation reports ZERO repos for an org, this
// step is skipped entirely and a warning logged instead of soft-deleting the whole registry, because
// an empty response is far more likely to be a transient failure than 221 repos actually vanishing
// at once (§3: 221 measured 2026-08-31).
//
// ── TWO PHASES, DELIBERATELY NOT ONE TRANSACTION ───────────────────────────────────────────────
// Phase 1 (collectGithubRepoData) is ALL NETWORK, NO DATABASE — the shared installation rate limiter
// serializes every call to one-in-flight-at-a-time (§4.7), so enriching ~221 repos can take minutes.
// Phase 2 (the withTenants block in syncGithubRepos) is ALL DATABASE, NO NETWORK. Interleaving them
// would hold a Postgres transaction open for the network phase's whole duration — a connection-pool
// and lock-duration hazard for no benefit, since nothing here needs read-your-writes across the two
// phases.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { githubRequest } from "./github-app.service";
import { GithubApiError } from "./errors";
import type { GithubAppRole } from "./apps";

/** The fairness-queue key (§4.7's `actingUserId`) this sweep uses — NOT a GitHub identity, just the
 *  queue slot a system-initiated job occupies, exactly as http-client.ts's own doc comment on
 *  `request()` describes for any non-human caller. A fixed constant (not per-run) is deliberate: a
 *  sweep tick and a concurrently-running manual crawl should fairly share one slot, not each mint a
 *  new one and starve unrelated human callers less than they otherwise would. */
export const GITHUB_REPO_SYNC_ACTOR = "system:github-repo-sync";

// ── raw GitHub shapes (only the fields this file reads) ──────────────────────────────────────────
interface RawGithubRepo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  visibility?: string;
  archived: boolean;
  topics?: string[];
  default_branch: string;
  created_at: string;
  pushed_at: string | null;
}

interface RawInstallationRepoPage {
  total_count?: number;
  repositories?: RawGithubRepo[];
}

interface RawCommit {
  sha: string;
  commit: {
    author?: { name?: string; email?: string; date?: string };
    committer?: { date?: string };
  };
}

interface RawWorkflowRun {
  status: string | null;
  conclusion: string | null;
  run_started_at?: string;
  created_at?: string;
}

interface RawWorkflowRunsPage {
  workflow_runs?: RawWorkflowRun[];
}

interface RawRelease {
  tag_name: string;
}

// Only used for its .length — the fields of an open PR are irrelevant here, so this is
// deliberately not the same shape as RawGithubRepo (a PR is not a repo).
type RawPullRequest = Record<string, unknown>;

// ── tier-2 (best-effort, per-repo) detail ─────────────────────────────────────────────────────────
export interface RepoDetail {
  headSha: string | null;
  headCommittedAt: string | null;
  headAuthor: string | null;
  openPrCount: number;
  latestRunStatus: string | null;
  latestRunConclusion: string | null;
  latestRunAt: string | null;
  latestReleaseTag: string | null;
}

const EMPTY_DETAIL: RepoDetail = {
  headSha: null,
  headCommittedAt: null,
  headAuthor: null,
  openPrCount: 0,
  latestRunStatus: null,
  latestRunConclusion: null,
  latestRunAt: null,
  latestReleaseTag: null,
};

export interface EnrichedRepo extends RepoDetail {
  fullName: string;
  name: string;
  htmlUrl: string;
  visibility: "public" | "private" | "internal";
  archived: boolean;
  topics: string[];
  defaultBranch: string;
  repoCreatedAt: string;
  pushedAt: string | null;
}

/** Paginate `/installation/repositories` to exhaustion — the same endpoint and the same stop
 *  condition (`repositories.length === 0` OR accumulated count reaches `total_count`) as
 *  `scripts/github-app/inventory-org.mjs` (read, not modified, per this ticket's scope boundary),
 *  mirrored here rather than shared because that script is a standalone throwaway tool with its own
 *  fetch/JWT plumbing, not an importable module. 221 repos / 100 per page = 3 pages measured
 *  2026-08-31 (§3) — pagination is not optional here. */
async function listInstallationRepos(
  tenantId: string,
  role: GithubAppRole,
  actingUserId: string,
): Promise<RawGithubRepo[]> {
  const perPage = 100;
  const all: RawGithubRepo[] = [];
  for (let page = 1; ; page++) {
    const res = await githubRequest<RawInstallationRepoPage>(tenantId, role, actingUserId, {
      path: `/installation/repositories?per_page=${perPage}&page=${page}`,
    });
    const batch = res.data.repositories ?? [];
    all.push(...batch);
    if (batch.length === 0 || all.length >= (res.data.total_count ?? 0)) break;
  }
  return all;
}

/** Best-effort per-repo enrichment (§5.2's CI/PR/release/head-commit columns). Every sub-fetch is
 *  independently wrapped: ONE repo's flaky Actions API response must never abort the other 220.
 *  `onWarn` is injected (not a bare `console.warn`) so tests can assert on degraded-but-successful
 *  behaviour without scraping stdout. */
export async function loadRepoDetail(
  tenantId: string,
  role: GithubAppRole,
  actingUserId: string,
  repo: Pick<RawGithubRepo, "full_name" | "default_branch" | "pushed_at">,
  onWarn: (message: string) => void,
): Promise<RepoDetail> {
  const detail: RepoDetail = { ...EMPTY_DETAIL };
  const tasks: Promise<void>[] = [];

  // §5.2: "null head_sha/... for a genuinely empty repo — treating that as an error would be
  // wrong, it is a true fact." The repo LIST call already told us this (pushed_at is null for a
  // never-pushed repo) — skip the extra round trip rather than asking GitHub a question its own
  // list response already answered.
  if (repo.pushed_at) {
    tasks.push(
      (async () => {
        try {
          const res = await githubRequest<RawCommit>(tenantId, role, actingUserId, {
            path: `/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`,
          });
          detail.headSha = res.data.sha;
          detail.headCommittedAt = res.data.commit.author?.date ?? res.data.commit.committer?.date ?? null;
          const author = res.data.commit.author;
          detail.headAuthor = author?.name ? `${author.name}${author.email ? ` <${author.email}>` : ""}` : null;
        } catch (e) {
          onWarn(`head commit fetch failed for ${repo.full_name}: ${(e as Error).message}`);
        }
      })(),
    );
  }

  tasks.push(
    (async () => {
      try {
        const res = await githubRequest<RawPullRequest[]>(tenantId, role, actingUserId, {
          path: `/repos/${repo.full_name}/pulls?state=open&per_page=100`,
        });
        detail.openPrCount = Array.isArray(res.data) ? res.data.length : 0;
      } catch (e) {
        onWarn(`open PR count fetch failed for ${repo.full_name}: ${(e as Error).message}`);
      }
    })(),
  );

  tasks.push(
    (async () => {
      try {
        const res = await githubRequest<RawWorkflowRunsPage>(tenantId, role, actingUserId, {
          path: `/repos/${repo.full_name}/actions/runs?per_page=1`,
        });
        const run = res.data.workflow_runs?.[0];
        if (run) {
          detail.latestRunStatus = run.status ?? null;
          detail.latestRunConclusion = run.conclusion ?? null;
          detail.latestRunAt = run.run_started_at ?? run.created_at ?? null;
        }
      } catch (e) {
        onWarn(`actions runs fetch failed for ${repo.full_name}: ${(e as Error).message}`);
      }
    })(),
  );

  tasks.push(
    (async () => {
      try {
        const res = await githubRequest<RawRelease>(tenantId, role, actingUserId, {
          path: `/repos/${repo.full_name}/releases/latest`,
        });
        detail.latestReleaseTag = res.data.tag_name ?? null;
      } catch (e) {
        // 404 = no releases published — an expected true fact (§5.1: most of these 221 repos have
        // never cut one), not a failure worth a warning line.
        if (!(e instanceof GithubApiError && e.status === 404)) {
          onWarn(`latest release fetch failed for ${repo.full_name}: ${(e as Error).message}`);
        }
      }
    })(),
  );

  await Promise.all(tasks);
  return detail;
}

function toEnrichedRepo(raw: RawGithubRepo, detail: RepoDetail): EnrichedRepo {
  const visibility = (raw.visibility as EnrichedRepo["visibility"] | undefined) ?? (raw.private ? "private" : "public");
  return {
    fullName: raw.full_name,
    name: raw.name,
    htmlUrl: raw.html_url,
    visibility,
    archived: raw.archived,
    topics: raw.topics ?? [],
    defaultBranch: raw.default_branch,
    repoCreatedAt: raw.created_at,
    pushedAt: raw.pushed_at,
    ...detail,
  };
}

export interface CollectGithubRepoDataOptions {
  tenantId: string;
  role: GithubAppRole;
  actingUserId: string;
  /** Tier-2 enrichment (head commit / open PRs / latest run / latest release) — 3-4 extra calls
   *  PER REPO. Default true for a real crawl; tests that only care about tier-1 identity/state
   *  fields can set this false to keep fixtures small. */
  includeDetail: boolean;
  onWarn: (message: string) => void;
}

/** Phase 1 — all network, zero database. Exported separately from `syncGithubRepos` so the
 *  fetch/enrich logic is unit-testable against a mocked `githubRequest` with no Postgres at all. */
export async function collectGithubRepoData(opts: CollectGithubRepoDataOptions): Promise<EnrichedRepo[]> {
  const raw = await listInstallationRepos(opts.tenantId, opts.role, opts.actingUserId);
  return Promise.all(
    raw.map(async (r) => {
      const detail = opts.includeDetail
        ? await loadRepoDetail(opts.tenantId, opts.role, opts.actingUserId, r, opts.onWarn)
        : EMPTY_DETAIL;
      return toEnrichedRepo(r, detail);
    }),
  );
}

/** Phase 2, one row: idempotent upsert keyed on `ux_github_repos_org_full_name` (org, full_name)
 *  WHERE deleted_at IS NULL — the same partial-unique arbiter GH-05's migration built. Running this
 *  twice with the same input is a no-op past the first call (UPDATE sets the same values), which is
 *  what "running the crawl twice must not duplicate or churn rows" requires structurally, not by
 *  convention. */
async function upsertRepoRow(
  client: PoolClient,
  tenantId: string,
  org: string,
  repo: EnrichedRepo,
  syncedAt: string,
): Promise<"inserted" | "updated"> {
  const res = await client.query<{ inserted: boolean }>(
    `INSERT INTO github_repos
       (id, tenant_id, org, name, full_name, html_url, visibility, archived, topics, default_branch,
        head_sha, head_committed_at, head_author, open_pr_count, latest_run_status,
        latest_run_conclusion, latest_run_at, latest_release_tag, repo_created_at, pushed_at,
        last_synced_at, origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (org, full_name) WHERE deleted_at IS NULL DO UPDATE SET
       name = EXCLUDED.name,
       html_url = EXCLUDED.html_url,
       visibility = EXCLUDED.visibility,
       archived = EXCLUDED.archived,
       topics = EXCLUDED.topics,
       default_branch = EXCLUDED.default_branch,
       head_sha = EXCLUDED.head_sha,
       head_committed_at = EXCLUDED.head_committed_at,
       head_author = EXCLUDED.head_author,
       open_pr_count = EXCLUDED.open_pr_count,
       latest_run_status = EXCLUDED.latest_run_status,
       latest_run_conclusion = EXCLUDED.latest_run_conclusion,
       latest_run_at = EXCLUDED.latest_run_at,
       latest_release_tag = EXCLUDED.latest_release_tag,
       repo_created_at = EXCLUDED.repo_created_at,
       pushed_at = EXCLUDED.pushed_at,
       last_synced_at = EXCLUDED.last_synced_at,
       updated_at = now()
       -- Deliberately NOT set here: tenant_id, org, full_name (the conflict key / tenancy — §5.2's
       -- ruling, never changes), webdev_site_id, project_id (the ERP-owned link — §5.1), deployed_ref
       -- (no source in this ticket), created_at, deleted_at, origin_site.
     RETURNING (xmax = 0) AS inserted`,
    [
      newId(),
      tenantId,
      org,
      repo.name,
      repo.fullName,
      repo.htmlUrl,
      repo.visibility,
      repo.archived,
      repo.topics,
      repo.defaultBranch,
      repo.headSha,
      repo.headCommittedAt,
      repo.headAuthor,
      repo.openPrCount,
      repo.latestRunStatus,
      repo.latestRunConclusion,
      repo.latestRunAt,
      repo.latestReleaseTag,
      repo.repoCreatedAt,
      repo.pushedAt,
      syncedAt,
      config.originSite,
    ],
  );
  return res.rows[0].inserted ? "inserted" : "updated";
}

/** Soft-delete (never hard-delete — history stays for audit) any LIVE row for `org` this tenant
 *  already had that the current full enumeration did NOT see. `seenFullNames` is guaranteed
 *  non-empty by the caller (it is derived FROM at least one fetched repo bearing this org), so the
 *  `<> ALL($3)` predicate can never degrade to "match everything". */
async function softDeleteMissingRepos(
  client: PoolClient,
  tenantId: string,
  org: string,
  seenFullNames: string[],
): Promise<number> {
  const res = await client.query(
    `UPDATE github_repos
        SET deleted_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND org = $2 AND deleted_at IS NULL AND full_name <> ALL($3::text[])`,
    [tenantId, org, seenFullNames],
  );
  return res.rowCount ?? 0;
}

export interface SyncGithubReposOptions {
  tenantId: string;
  role?: GithubAppRole;
  actingUserId?: string;
  /** See CollectGithubRepoDataOptions.includeDetail. Default true. */
  includeDetail?: boolean;
}

export interface SyncGithubReposResult {
  tenantId: string;
  /** Org logins actually seen in this pass — usually exactly one (`gaiadabali`), never assumed to
   *  be (§3: `org` is deliberately not CHECK-constrained to one value). */
  orgsSeen: string[];
  fetched: number;
  inserted: number;
  updated: number;
  softDeleted: number;
  syncedAt: string;
  warnings: string[];
}

/** The GH-06 entry point. First call for a tenant = the initial crawl; every later call = the
 *  reconcile sweep — same function, see this file's header. System-initiated, no HTTP principal —
 *  matches `work-activity-ingest.service.ts`'s established shape for an internal writer (no
 *  `authorize()` call; the caller is a background loop, not a request). */
export async function syncGithubRepos(opts: SyncGithubReposOptions): Promise<SyncGithubReposResult> {
  const role = opts.role ?? "erp";
  const actingUserId = opts.actingUserId ?? GITHUB_REPO_SYNC_ACTOR;
  const includeDetail = opts.includeDetail ?? true;
  const warnings: string[] = [];
  const onWarn = (message: string): void => {
    warnings.push(message);
    // eslint-disable-next-line no-console
    console.warn(`[github-repo-sync] ${message}`);
  };

  const enriched = await collectGithubRepoData({ tenantId: opts.tenantId, role, actingUserId, includeDetail, onWarn });

  const syncedAt = new Date().toISOString();
  const byOrg = new Map<string, string[]>();
  for (const r of enriched) {
    const org = r.fullName.split("/")[0];
    const list = byOrg.get(org);
    if (list) list.push(r.fullName);
    else byOrg.set(org, [r.fullName]);
  }

  let inserted = 0;
  let updated = 0;
  let softDeleted = 0;

  if (enriched.length > 0) {
    await withTenants([opts.tenantId], async (client) => {
      for (const r of enriched) {
        const org = r.fullName.split("/")[0];
        const outcome = await upsertRepoRow(client, opts.tenantId, org, r, syncedAt);
        if (outcome === "inserted") inserted++;
        else updated++;
      }
      for (const [org, fullNames] of byOrg) {
        softDeleted += await softDeleteMissingRepos(client, opts.tenantId, org, fullNames);
      }
    });
  } else {
    onWarn(
      "installation reported zero repositories — skipping the soft-delete reconcile pass entirely " +
        "(221 repos measured 2026-08-31; treating an empty response as truth would wipe the registry " +
        "on what is far more likely a transient failure)",
    );
  }

  return {
    tenantId: opts.tenantId,
    orgsSeen: [...byOrg.keys()],
    fetched: enriched.length,
    inserted,
    updated,
    softDeleted,
    syncedAt,
    warnings,
  };
}

/** Background loop starter — same shape as `startDriftSweepLoop`
 *  (events/reconcile-consumer.ts) and every other plain-Postgres sweep in `main.ts`: fires once
 *  immediately, then re-arms on a fixed interval, catching and logging (never throwing out of the
 *  loop) so one bad tick doesn't kill the sweep permanently. */
export function startGithubRepoSyncLoop(tenantId: string, intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await syncGithubRepos({ tenantId });
      if (result.softDeleted > 0 || result.warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn("[GITHUB-REPO-SYNC] drift or warnings this pass:", {
          fetched: result.fetched,
          inserted: result.inserted,
          updated: result.updated,
          softDeleted: result.softDeleted,
          warningCount: result.warnings.length,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("github repo sync tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
