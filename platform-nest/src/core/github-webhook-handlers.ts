// GH-07 (docs/blueprints/github-integration-foundation.md §4.5, §5.3) — per-event webhook handlers
// for `POST /api/webhooks/github`. Two jobs, kept in one file because every event needs both:
//
//  1. Keep the seven VOLATILE `github_repos` columns (§5.3) fresh — head_sha/head_committed_at/
//     head_author, open_pr_count, latest_run_status/conclusion/at, latest_release_tag, deployed_ref —
//     the ones GH-06's periodic sweep is too expensive to poll for (§5.3's measured "3-4 extra calls
//     PER REPO" cost). This is the FAST PATH; the sweep is the RECONCILE path and still runs on its
//     own slower cycle to catch whatever a missed/failed delivery leaves stale.
//  2. §4.5 REVERSE ATTRIBUTION — the heart of this ticket. Every inbound event says
//     `gaiada-erp[bot]`. `resolveGithubActor()` below correlates SHA back to the `activities` row
//     GH-04's ledger (core/github/ledger.ts) wrote at request time, and resolves the REAL human. When
//     correlation fails, the event is recorded UNATTRIBUTED — `actor_user_id = NULL`,
//     `actor_external = 'gaiada-erp[bot]'`, `payload.unattributed = true` — never silently credited
//     to the bot (§4.5's own words: "an unattributed bot action is either an out-of-band change or a
//     ledger gap, and both are things you want to see").
//
// ── WHY SHA, NOT THE §4.4 TRAILER, IS THE AUTHORITATIVE KEY ────────────────────────────────────────
// §4.4 says the commit trailer (`Gaiada-Activity: <activities.id>`) "is the correlation handle §4.5's
// webhook reverse-mapping needs" — and this file does parse it (`parseActivityTrailer`), for the O(1)
// lookup it enables. But the trailer is text INSIDE a commit message, which is not something this
// receiver can trust on its own: a bad actor pushing out-of-band (exactly the case §4.5 exists to
// catch) could copy an OLD trailer verbatim into a new, unrelated commit. So a trailer match is only
// ever ACCEPTED after confirming the resolved `activities` row's own `metadata.sha` — the sha GitHub
// itself returned when the ERP made that original write, unforgeable by construction — equals THIS
// event's sha. A copied trailer pointing at a real-but-unrelated activity fails that check and falls
// through to plain SHA correlation (which then correctly finds nothing and reports unattributed,
// because the sha genuinely doesn't appear in the ledger). The trailer is a fast lookup, not a
// trusted claim; the sha is what actually establishes the match either way.
//
// ── GH-10 (the write arm) HAS NOT SHIPPED ──────────────────────────────────────────────────────────
// No commit trailer, no ledger row with a real sha, exists in this checkout today — GH-10 is what
// will start writing them. Every correlation this file attempts against a live delivery will
// therefore report `unattributed: true` until GH-10 lands, and THAT IS THE CORRECT, REQUIRED
// behaviour per this ticket's own acceptance criterion: "an out-of-band push lands
// actor_user_id=NULL flagged, not credited to the bot." This file's tests exercise both paths by
// seeding a real `activities` row first (the attributed case) and by not seeding one (the
// unattributed case) — see github-webhook-handlers.db.test.ts.
//
// ── open_pr_count IS APPROXIMATE ON THE FAST PATH, BY DESIGN ───────────────────────────────────────
// A `pull_request` webhook increments/decrements rather than re-fetching the true count (this ticket
// forbids live GitHub calls, and re-deriving the exact count needs one). §5.3's own cost accounting
// is why: an exact count costs a real API call GH-06's sweep already budgets for on its slower cycle.
// Drift (a missed delivery, an out-of-order redelivery) self-heals on the next sweep tick — never
// worse than what existed before webhooks existed at all (a value only as fresh as the last sweep).
//
// ── check_suite IS LOGGED, NEVER WRITTEN TO github_repos ───────────────────────────────────────────
// workflow_run already owns latest_run_status/conclusion/at for this org's Actions-based CI (§3: no
// other Checks-API app is in use). Two webhook sources racing to set the same three columns risks one
// clobbering the other with a STALER value depending on delivery order, so check_suite is recorded as
// work_activity only.
//
// ── REUSE, NOT DUPLICATION, OF GH-06's UPSERT LOGIC ─────────────────────────────────────────────────
// This ticket's scope explicitly forbids modifying `repo-sync.service.ts`, and its own `upsertRepoRow`
// is a private (unexported) function — nothing here calls it, and nothing here re-implements its
// EXPENSIVE part (the 4-calls-per-repo enrichment crawl: head commit, open PRs, latest run, latest
// release). What this file writes instead is a set of small, TARGETED `UPDATE`s (and, for
// `repository.created`/`edited`, a minimal upsert using only the fields a webhook payload already
// carries for free) — a materially different, much cheaper operation than the sweep's, not a copy of
// it. See individual handlers for exactly which columns each event touches.
import type { PoolClient } from "pg";
import { config } from "../config";
import { withTenants } from "../db";
import { GITHUB_APPS } from "./github/apps";
import { ingestWorkActivity } from "./work-activity-ingest.service";

const BOT_LOGIN = `${GITHUB_APPS.erp.slug}[bot]`; // "gaiada-erp[bot]" — §1
const MAX_COMMITS_PER_PUSH = 300; // defensive cap; GitHub itself already truncates large pushes

// ── §4.4's commit trailer ────────────────────────────────────────────────────────────────────────
const ACTIVITY_TRAILER_RE = /^Gaiada-Activity:\s*([0-9a-fA-F-]{36})\s*$/m;

function parseActivityTrailer(commitMessage: string | undefined | null): string | null {
  if (!commitMessage) return null;
  const m = ACTIVITY_TRAILER_RE.exec(commitMessage);
  return m ? m[1] : null;
}

interface LedgerMatch {
  activityId: string;
  actorId: string | null;
}

/** O(1) lookup by the trailer's own id — ONLY trusted after the sha cross-check (see file header).
 *  Reads `activities` directly (core, RLS = tenant isolation only, per its own migration) — this is a
 *  read added for GH-07, not a change to core/github/ledger.ts, which this ticket must not modify. */
async function findLedgerActivityById(
  client: PoolClient, tenantId: string, activityId: string, fullName: string, sha: string,
): Promise<LedgerMatch | null> {
  const r = await client.query<{ id: string; actor_id: string | null; metadata: { repo?: string; sha?: string } }>(
    `SELECT id, actor_id, metadata FROM activities
      WHERE id = $1 AND tenant_id = $2 AND verb LIKE 'github.%' AND metadata->>'outcome' = 'succeeded'`,
    [activityId, tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Both checks are load-bearing (see file header): repo scopes the match to the right target, sha
  // is what makes a copied/stale trailer fail rather than falsely attribute.
  if (row.metadata?.repo !== fullName) return null;
  if (row.metadata?.sha !== sha) return null;
  return { activityId: row.id, actorId: row.actor_id };
}

/** The fallback (and, until GH-10 ships, the ONLY reachable) correlation path: the most recent
 *  succeeded push/merge ledger row for this exact repo+sha. Sha is a cryptographic hash of the
 *  commit — collision with an unrelated write is not a realistic concern. */
async function findLedgerActivityBySha(
  client: PoolClient, tenantId: string, fullName: string, sha: string,
): Promise<LedgerMatch | null> {
  const r = await client.query<{ id: string; actor_id: string | null }>(
    `SELECT id, actor_id FROM activities
      WHERE tenant_id = $1 AND verb IN ('github.push', 'github.merge')
        AND metadata->>'outcome' = 'succeeded'
        AND metadata->>'repo' = $2
        AND metadata->>'sha' = $3
      ORDER BY occurred_at DESC LIMIT 1`,
    [tenantId, fullName, sha],
  );
  const row = r.rows[0];
  return row ? { activityId: row.id, actorId: row.actor_id } : null;
}

export interface AttributionResult {
  actorUserId: string | null;
  actorExternal: string;
  unattributed: boolean;
  reason?: string;
  correlationId?: string;
}

/** §4.5's own function. `senderLogin`/`senderType` come straight off the webhook payload's `sender`
 *  object — GitHub sets `sender.type === "Bot"` and `sender.login === "gaiada-erp[bot]"` for
 *  App-authored events. An event NOT authored by the bot at all (some other identity pushed
 *  directly) is, by construction, out-of-band — the ERP is supposed to be the sole writer (§1) — so
 *  it is flagged unattributed too, with that identity recorded verbatim rather than discarded. */
export async function resolveGithubActor(
  client: PoolClient,
  tenantId: string,
  params: { fullName: string; sha: string | null; commitMessage?: string | null; senderLogin?: string | null; senderType?: string | null },
): Promise<AttributionResult> {
  const isBotAuthored =
    !params.senderLogin || params.senderLogin === BOT_LOGIN || params.senderType === "Bot";

  if (!isBotAuthored) {
    return {
      actorUserId: null,
      actorExternal: params.senderLogin ?? "unknown",
      unattributed: true,
      reason: "event not authored by gaiada-erp[bot] — out-of-band",
    };
  }

  if (!params.sha) {
    return { actorUserId: null, actorExternal: BOT_LOGIN, unattributed: true, reason: "no sha on this event to correlate" };
  }

  let match: LedgerMatch | null = null;
  const trailerId = parseActivityTrailer(params.commitMessage);
  if (trailerId) {
    match = await findLedgerActivityById(client, tenantId, trailerId, params.fullName, params.sha);
  }
  if (!match) {
    match = await findLedgerActivityBySha(client, tenantId, params.fullName, params.sha);
  }

  if (match) {
    return { actorUserId: match.actorId, actorExternal: BOT_LOGIN, unattributed: false, correlationId: match.activityId };
  }
  return { actorUserId: null, actorExternal: BOT_LOGIN, unattributed: true, reason: "no matching ledger row for this sha" };
}

// ── event payload shapes (only the fields each handler reads) ──────────────────────────────────────
interface GhSender { login?: string; type?: string }
interface GhRepository {
  full_name: string; name: string; html_url: string; default_branch: string;
  visibility?: string; private?: boolean; archived?: boolean; topics?: string[];
  created_at?: string; pushed_at?: string | null;
}
interface GhCommit { id: string; message: string; timestamp?: string; author?: { name?: string; email?: string } }

export interface HandlerResult {
  note: string;
}

async function updateRepoColumns(tenantId: string, fullName: string, sets: string[], args: unknown[]): Promise<void> {
  if (!sets.length) return;
  const fullArgs = [...args, fullName];
  await withTenants([tenantId], (client) =>
    client.query(
      `UPDATE github_repos SET ${sets.join(", ")}, updated_at = now() WHERE full_name = $${fullArgs.length} AND deleted_at IS NULL`,
      fullArgs,
    ),
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// push — §5.3 (head_sha/head_committed_at/head_author, pushed_at) + the deployed_ref bonus (§5.4's
// acknowledged hole, blueprint header): a push to `refs/heads/deploy/staging-*` or
// `refs/heads/deploy/production-*` IS the deploy-workflows artifact-branch signal §2.2 describes —
// this is that source, wired.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const DEPLOY_BRANCH_RE = /^refs\/heads\/(deploy\/(?:staging|production)-.+)$/;

async function handlePush(tenantId: string, payload: Record<string, unknown>): Promise<HandlerResult> {
  const repo = payload.repository as GhRepository | undefined;
  if (!repo?.full_name) return { note: "push: no repository.full_name" };
  const fullName = repo.full_name;
  const ref = String(payload.ref ?? "");
  const after = String(payload.after ?? "");
  const isBranchDelete = /^0+$/.test(after) && after.length > 0;
  const isDefaultBranchPush = ref === `refs/heads/${repo.default_branch}`;
  const sender = payload.sender as GhSender | undefined;
  const headCommit = payload.head_commit as GhCommit | undefined;
  const deployMatch = DEPLOY_BRANCH_RE.exec(ref);

  if (!isBranchDelete) {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (isDefaultBranchPush && headCommit) {
      sets.push(`head_sha = $${args.push(after)}`);
      sets.push(`head_committed_at = $${args.push(headCommit.timestamp ?? null)}`);
      const author = headCommit.author;
      const authorStr = author?.name ? `${author.name}${author.email ? ` <${author.email}>` : ""}` : null;
      sets.push(`head_author = $${args.push(authorStr)}`);
      sets.push(`pushed_at = now()`);
    }
    if (deployMatch) {
      // §2.2: deploy/staging-* -> delphi, deploy/production-* -> helios. This column records WHICH
      // artifact branch was last pushed, not which host pulled it — the pull side has no webhook of
      // its own to report success (§2.2's pull model), so "last pushed" is the closest fact this
      // receiver can honestly claim. Documented as such in the report, not asserted as "deployed".
      sets.push(`deployed_ref = $${args.push(deployMatch[1])}`);
    }
    await updateRepoColumns(tenantId, fullName, sets, args);
  }

  const commits = Array.isArray(payload.commits) ? (payload.commits as GhCommit[]).slice(0, MAX_COMMITS_PER_PUSH) : [];
  for (const c of commits) {
    // eslint-disable-next-line no-await-in-loop
    const attribution = await withTenants([tenantId], (client) =>
      resolveGithubActor(client, tenantId, {
        fullName, sha: c.id, commitMessage: c.message,
        senderLogin: sender?.login ?? null, senderType: sender?.type ?? null,
      }),
    );
    // eslint-disable-next-line no-await-in-loop
    await ingestWorkActivity(tenantId, {
      source: "github",
      sourceRef: `${fullName}@${c.id}`,
      actorUserId: attribution.actorUserId,
      actorExternal: attribution.actorExternal,
      verb: "committed",
      objectKind: "commit",
      objectRef: c.id,
      title: (c.message ?? "").split("\n")[0].slice(0, 200),
      payload: {
        repo: fullName, ref,
        unattributed: attribution.unattributed,
        reason: attribution.reason ?? null,
        correlationId: attribution.correlationId ?? null,
        botLogin: BOT_LOGIN,
      },
      occurredAt: c.timestamp ?? null,
    });
  }

  return { note: `push ${fullName} ref=${ref} commits=${commits.length} defaultBranch=${isDefaultBranchPush} deployRef=${deployMatch?.[1] ?? "none"}` };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// pull_request — open_pr_count (approximate, §5.3) + reverse attribution for an actual MERGE
// (the ledger's `merge` action; a merge produces a real commit sha this receiver can correlate on
// exactly like a push). Non-merge lifecycle actions (opened/labeled/synchronize/...) are recorded
// plainly with GitHub's own sender identity — nothing in this ticket's scope writes a ledger row for
// "opened a PR", so there is nothing yet to correlate against, and marking those unattributed would
// misrepresent "nothing to check" as "checked and failed".
// ══════════════════════════════════════════════════════════════════════════════════════════════════
async function handlePullRequest(tenantId: string, payload: Record<string, unknown>): Promise<HandlerResult> {
  const repo = payload.repository as GhRepository | undefined;
  const pr = payload.pull_request as { number: number; title?: string; merged?: boolean; merge_commit_sha?: string | null } | undefined;
  const action = payload.action as string | undefined;
  if (!repo?.full_name || !pr || !action) return { note: "pull_request: missing repository/pull_request/action" };
  const fullName = repo.full_name;
  const sender = payload.sender as GhSender | undefined;
  const merged = pr.merged === true;

  if (action === "opened" || action === "reopened") {
    await updateRepoColumns(tenantId, fullName, ["open_pr_count = open_pr_count + 1"], []);
  } else if (action === "closed") {
    await updateRepoColumns(tenantId, fullName, ["open_pr_count = GREATEST(open_pr_count - 1, 0)"], []);
  }

  let attribution: AttributionResult;
  if (merged && pr.merge_commit_sha) {
    attribution = await withTenants([tenantId], (client) =>
      resolveGithubActor(client, tenantId, {
        fullName, sha: pr.merge_commit_sha ?? null, commitMessage: pr.title,
        senderLogin: sender?.login ?? null, senderType: sender?.type ?? null,
      }),
    );
  } else {
    attribution = { actorUserId: null, actorExternal: sender?.login ?? BOT_LOGIN, unattributed: false };
  }

  const verb = merged ? "merged" : action;
  await ingestWorkActivity(tenantId, {
    source: "github",
    sourceRef: `${fullName}#${pr.number}:${action}`,
    actorUserId: attribution.actorUserId,
    actorExternal: attribution.actorExternal,
    verb,
    objectKind: "pull_request",
    objectRef: String(pr.number),
    title: pr.title ?? null,
    payload: {
      repo: fullName, prNumber: pr.number, action, merged,
      unattributed: attribution.unattributed,
      reason: attribution.reason ?? null,
      correlationId: attribution.correlationId ?? null,
    },
  });

  return { note: `pull_request ${fullName}#${pr.number} action=${action} merged=${merged}` };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// workflow_run — latest_run_status/conclusion/at. Out-of-order-delivery guard: only overwrite when
// this run is at-or-after whatever is already stored.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
async function handleWorkflowRun(tenantId: string, payload: Record<string, unknown>): Promise<HandlerResult> {
  const repo = payload.repository as GhRepository | undefined;
  const run = payload.workflow_run as { id: number; status?: string | null; conclusion?: string | null; run_started_at?: string; created_at?: string; name?: string } | undefined;
  if (!repo?.full_name || !run) return { note: "workflow_run: missing repository/workflow_run" };
  const fullName = repo.full_name;
  const runAt = run.run_started_at ?? run.created_at ?? null;

  await withTenants([tenantId], (client) =>
    client.query(
      `UPDATE github_repos
          SET latest_run_status = $1, latest_run_conclusion = $2, latest_run_at = $3, updated_at = now()
        WHERE full_name = $4 AND deleted_at IS NULL
          AND (latest_run_at IS NULL OR ($3::timestamptz IS NOT NULL AND $3::timestamptz >= latest_run_at))`,
      [run.status ?? null, run.conclusion ?? null, runAt, fullName],
    ),
  );

  await ingestWorkActivity(tenantId, {
    source: "github",
    sourceRef: `${fullName}:run:${run.id}`,
    actorUserId: null,
    actorExternal: (payload.sender as GhSender | undefined)?.login ?? null,
    verb: "ci_run",
    objectKind: "workflow_run",
    objectRef: String(run.id),
    title: run.name ?? null,
    payload: { repo: fullName, status: run.status ?? null, conclusion: run.conclusion ?? null },
    occurredAt: runAt,
  });

  return { note: `workflow_run ${fullName} id=${run.id} status=${run.status ?? "?"}` };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// repository — identity/state fields a webhook payload carries for free. NOT a re-implementation of
// GH-06's enrichment upsert (head commit / open PRs / CI / release are not in this payload at all) —
// see file header.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
async function handleRepository(tenantId: string, payload: Record<string, unknown>): Promise<HandlerResult> {
  const action = payload.action as string | undefined;
  const repo = payload.repository as GhRepository | undefined;
  if (!repo?.full_name || !action) return { note: "repository: missing repository/action" };
  const fullName = repo.full_name;

  await withTenants([tenantId], async (client) => {
    if (action === "deleted") {
      await client.query(
        `UPDATE github_repos SET deleted_at = now(), updated_at = now() WHERE full_name = $1 AND deleted_at IS NULL`,
        [fullName],
      );
      return;
    }
    if (action === "archived" || action === "unarchived") {
      await client.query(
        `UPDATE github_repos SET archived = $1, updated_at = now() WHERE full_name = $2 AND deleted_at IS NULL`,
        [action === "archived", fullName],
      );
      return;
    }
    if (action === "created" || action === "edited" || action === "publicized" || action === "privatized") {
      const org = fullName.split("/")[0];
      const visibility = repo.visibility ?? (repo.private ? "private" : "public");
      await client.query(
        `INSERT INTO github_repos
           (id, tenant_id, org, name, full_name, html_url, visibility, archived, topics,
            default_branch, repo_created_at, pushed_at, last_synced_at, origin_site)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12)
         ON CONFLICT (org, full_name) WHERE deleted_at IS NULL DO UPDATE SET
           html_url = EXCLUDED.html_url,
           visibility = EXCLUDED.visibility,
           archived = EXCLUDED.archived,
           topics = EXCLUDED.topics,
           default_branch = EXCLUDED.default_branch,
           updated_at = now()`,
        [
          tenantId, org, repo.name, fullName, repo.html_url, visibility, !!repo.archived,
          repo.topics ?? [], repo.default_branch, repo.created_at ?? new Date().toISOString(),
          repo.pushed_at ?? null, config.originSite,
        ],
      );
      return;
    }
    if (action === "renamed" || action === "transferred") {
      const changes = payload.changes as { repository?: { full_name?: { from?: string } } } | undefined;
      const oldFullName = changes?.repository?.full_name?.from;
      if (oldFullName) {
        const org = fullName.split("/")[0];
        await client.query(
          `UPDATE github_repos SET org = $1, name = $2, full_name = $3, html_url = $4, updated_at = now()
            WHERE full_name = $5 AND deleted_at IS NULL`,
          [org, repo.name, fullName, repo.html_url, oldFullName],
        );
      }
      // No `changes.repository.full_name.from` in the payload — best-effort only; left for the next
      // reconcile sweep (§5.3) rather than guessed at.
    }
  });

  await ingestWorkActivity(tenantId, {
    source: "github",
    sourceRef: `${fullName}:repository:${action}`,
    actorUserId: null,
    actorExternal: (payload.sender as GhSender | undefined)?.login ?? null,
    verb: `repository_${action}`,
    objectKind: "repository",
    objectRef: fullName,
    title: fullName,
    payload: { repo: fullName, action },
  });

  return { note: `repository ${fullName} action=${action}` };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// release — latest_release_tag.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
async function handleRelease(tenantId: string, payload: Record<string, unknown>): Promise<HandlerResult> {
  const repo = payload.repository as GhRepository | undefined;
  const release = payload.release as { id: number; tag_name?: string } | undefined;
  const action = payload.action as string | undefined;
  if (!repo?.full_name || !release || !action) return { note: "release: missing repository/release/action" };
  const fullName = repo.full_name;

  if (action === "published" || action === "released") {
    await updateRepoColumns(tenantId, fullName, [`latest_release_tag = $${1}`], [release.tag_name ?? null]);
  }

  await ingestWorkActivity(tenantId, {
    source: "github",
    sourceRef: `${fullName}:release:${release.id}:${action}`,
    actorUserId: null,
    actorExternal: (payload.sender as GhSender | undefined)?.login ?? null,
    verb: `release_${action}`,
    objectKind: "release",
    objectRef: String(release.id),
    title: release.tag_name ?? null,
    payload: { repo: fullName, action, tag: release.tag_name ?? null },
  });

  return { note: `release ${fullName} tag=${release.tag_name ?? "?"} action=${action}` };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// deployment_status — the OTHER possible deployed_ref source (the Deployments API, not the
// deploy-workflows artifact-branch pull model §2.2 says this org actually uses — see report). Wired
// for completeness since the App subscribes to the event; not expected to fire on this org today.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
async function handleDeploymentStatus(tenantId: string, payload: Record<string, unknown>): Promise<HandlerResult> {
  const repo = payload.repository as GhRepository | undefined;
  const ds = payload.deployment_status as { id: number; state?: string } | undefined;
  const deployment = payload.deployment as { id: number; ref?: string; environment?: string } | undefined;
  if (!repo?.full_name || !ds || !deployment) return { note: "deployment_status: missing fields" };
  const fullName = repo.full_name;

  if (ds.state === "success" && deployment.ref) {
    await updateRepoColumns(tenantId, fullName, [`deployed_ref = $${1}`], [deployment.ref]);
  }

  await ingestWorkActivity(tenantId, {
    source: "github",
    sourceRef: `${fullName}:deployment:${deployment.id}:${ds.id}`,
    actorUserId: null,
    actorExternal: (payload.sender as GhSender | undefined)?.login ?? null,
    verb: "deployment_status",
    objectKind: "deployment",
    objectRef: String(deployment.id),
    title: `${deployment.environment ?? "?"}: ${ds.state ?? "?"}`,
    payload: { repo: fullName, state: ds.state ?? null, environment: deployment.environment ?? null, ref: deployment.ref ?? null },
  });

  return { note: `deployment_status ${fullName} state=${ds.state ?? "?"}` };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// check_suite — logged only, never written to github_repos (see file header).
// ══════════════════════════════════════════════════════════════════════════════════════════════════
async function handleCheckSuite(tenantId: string, payload: Record<string, unknown>): Promise<HandlerResult> {
  const repo = payload.repository as GhRepository | undefined;
  const cs = payload.check_suite as { id: number; status?: string; conclusion?: string } | undefined;
  const action = payload.action as string | undefined;
  if (!repo?.full_name || !cs || !action) return { note: "check_suite: missing fields" };
  const fullName = repo.full_name;

  await ingestWorkActivity(tenantId, {
    source: "github",
    sourceRef: `${fullName}:check_suite:${cs.id}:${action}`,
    actorUserId: null,
    actorExternal: (payload.sender as GhSender | undefined)?.login ?? null,
    verb: `check_suite_${action}`,
    objectKind: "check_suite",
    objectRef: String(cs.id),
    title: null,
    payload: { repo: fullName, action, status: cs.status ?? null, conclusion: cs.conclusion ?? null },
  });

  return { note: `check_suite ${fullName} action=${action} status=${cs.status ?? "?"}` };
}

function handlePing(payload: Record<string, unknown>): HandlerResult {
  return { note: `ping: ${typeof payload.zen === "string" ? payload.zen : "ok"}` };
}

/** The one entry point `github-webhook.controller.ts` calls. `event` is the `X-GitHub-Event` header
 *  value; the 7 cases below are exactly the 7 the App subscribes to (§3) plus `ping` (GitHub's own
 *  webhook-setup/redelivery-test event, sent regardless of subscription). Anything else is logged and
 *  acked, never a 500 — an App's event subscription can change over time and this receiver must not
 *  hard-fail on a type it doesn't yet know. */
export async function dispatchGithubWebhookEvent(
  tenantId: string,
  event: string,
  payload: unknown,
): Promise<HandlerResult> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  switch (event) {
    case "ping": return handlePing(p);
    case "push": return handlePush(tenantId, p);
    case "pull_request": return handlePullRequest(tenantId, p);
    case "workflow_run": return handleWorkflowRun(tenantId, p);
    case "repository": return handleRepository(tenantId, p);
    case "release": return handleRelease(tenantId, p);
    case "deployment_status": return handleDeploymentStatus(tenantId, p);
    case "check_suite": return handleCheckSuite(tenantId, p);
    default: return { note: `unhandled event type: ${event}` };
  }
}
