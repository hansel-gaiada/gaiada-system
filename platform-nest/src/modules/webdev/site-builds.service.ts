// WSK-60 — publish → rebuild → staging: the build ledger, the dispatch, and the stamp poll.
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §9 (Decision G) and §12 WSK-60.
// Runbook: infra/runbooks/webdesk-staging-rebuild.md.
//
// ── THE FLOW ─────────────────────────────────────────────────────────────────────────────────────
//   1. An approval executes: a WebDesk `content.publish` (WSK-66) or a `content.rebuild` (this ticket,
//      filed by the editor after an unpublish). The executor makes ONE call into `startSiteRebuild`.
//   2. `startSiteRebuild` claims a `webdev_site_builds` row (UNIQUE (tenant_id, approval_id): at most
//      one build per approval, so a duplicated hook call cannot dispatch twice), then sends ONE
//      `workflow_dispatch` through the GitHub chokepoint as `github_repo · deploy`, authorised by the
//      approval's id (WSK-D46 / R3). The workflow's own `concurrency` group coalesces bursts; the ERP
//      has no debounce and records EVERY dispatch.
//   3. A poller reads `<stagingUrl>/webdesk-build.json` every 30 s for up to 20 min. `live` only when
//      the stamp proves the content is there (site-build-stamp.ts); on timeout `unverified`. Never live.
//
// ── FAIL CLOSED, VISIBLE, AND NEVER THE PUBLISH'S PROBLEM ────────────────────────────────────────
// `startSiteRebuild` NEVER throws. A dispatch that could not happen (App not installed, no target
// configured, Cerbos refused, GitHub down) leaves the row `failed` with a typed `failure_reason`, and
// the publish that triggered it stands. The editor then reads `state: "failed"` from build-status; it is
// never shown as rebuilding or live. The reason is on the row and in the approval's execution result.
//
// ── TENANCY ──────────────────────────────────────────────────────────────────────────────────────
// Ledger rows are the WEBDEV company's (`tenant_id` = the approval's tenant), under the third wall, read
// and written only in the `webdev` module scope. The GitHub side is the ORG tenant's (the App credential
// and the `github.deploy` activities rows): `workflow-dispatch.ts` resolves it and authorises the decider
// against it. The two are the same company on today's estate and need not be.
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import type { Principal } from "../../rbac/principal";
import { isModuleEnabled } from "../registry";
import {
  WorkflowDispatchError,
  dispatchApprovedWorkflow,
  type ClientPublishAuthority,
  type WorkflowDispatchFailure,
} from "../../core/github/workflow-dispatch";
import { readStagingStamp, stampProves, type StampFetchOptions } from "./site-build-stamp";

const logger = new Logger("SiteBuilds");

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Shapes
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type BuildKind = "publish" | "rebuild";
export type BuildState = "rebuilding" | "live" | "unverified" | "failed";

/** The ledger's own reasons, beside the dispatch's (workflow-dispatch.ts). */
export type BuildFailureReason =
  | WorkflowDispatchFailure
  /** No `WEBDESK_REBUILD_TARGETS` entry names this site. */
  | "rebuild_not_configured"
  /** The dispatch outlived its deadline, or the process died before GitHub's answer was recorded. It MAY
   *  have started a run; the ledger cannot tell, so it says so rather than guessing either way. */
  | "dispatch_unconfirmed"
  /** The ledger row itself could not be written. */
  | "build_ledger_unavailable"
  /** WSK-61: a scheduled publish went live, but the approval's decider is no longer an active user, so
   *  nobody can authorise the dispatch. Nothing was sent; the editor files a `content.rebuild`. */
  | "decider_inactive";

/** EXACTLY the editor's wire shape (platform-ui `parseBuildStatus`, WSK-44). No extra key. */
export interface BuildStatusBuild {
  approvalId: string | null;
  kind: BuildKind;
  requestedAt: string;
  publishedAt: string | null;
  state: BuildState;
  stagingUrl: string | null;
  verifiedAt: string | null;
}
export interface BuildStatusBody {
  build: BuildStatusBuild | null;
  stagingStale: boolean;
}

/** The fixed key set of the two objects above. The wire test asserts `Object.keys` equals these. */
export const BUILD_STATUS_KEYS = ["build", "stagingStale"] as const;
export const BUILD_KEYS = ["approvalId", "kind", "requestedAt", "publishedAt", "state", "stagingUrl", "verifiedAt"] as const;

export interface RebuildTarget {
  tenantSlug: string;
  siteId: string;
  /** `owner/name` of the site repo. */
  repo: string;
  /** The workflow file, e.g. `webdesk-rebuild.yml`. */
  workflow: string;
  ref: string;
  /** The staging site's origin, e.g. `https://24-pyevq.gaiada.com`. */
  stagingUrl: string;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Targets (config)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_RE = /^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;

/** Parse `WEBDESK_REBUILD_TARGETS`. A malformed document or entry is dropped and logged, so a typo can
 *  only ever REMOVE a target (every rebuild for it then fails `rebuild_not_configured`, visibly). */
export function parseRebuildTargets(json: string, warn: (m: string) => void = (m) => logger.warn(m)): RebuildTarget[] {
  if (!json.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    warn("WEBDESK_REBUILD_TARGETS is not valid JSON; no rebuild target is configured");
    return [];
  }
  if (!Array.isArray(raw)) {
    warn("WEBDESK_REBUILD_TARGETS must be a JSON array; no rebuild target is configured");
    return [];
  }
  const out: RebuildTarget[] = [];
  raw.forEach((e, i) => {
    const o = e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : null;
    const bad = (why: string) => warn(`WEBDESK_REBUILD_TARGETS[${i}] dropped: ${why}`);
    if (!o) return bad("not an object");
    const { tenantSlug, siteId, repo, workflow, ref, stagingUrl } = o;
    if (typeof tenantSlug !== "string" || !SLUG_RE.test(tenantSlug)) return bad("tenantSlug");
    if (typeof siteId !== "string" || !UUID_RE.test(siteId)) return bad("siteId");
    if (typeof repo !== "string" || !REPO_RE.test(repo)) return bad("repo");
    if (typeof workflow !== "string" || !WORKFLOW_RE.test(workflow)) return bad("workflow");
    if (typeof ref !== "string" || !/^[A-Za-z0-9_./-]{1,200}$/.test(ref)) return bad("ref");
    let origin: string;
    try {
      const u = new URL(String(stagingUrl));
      if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))) return bad("stagingUrl must be https");
      origin = u.origin;
    } catch {
      return bad("stagingUrl");
    }
    out.push({ tenantSlug, siteId: siteId.toLowerCase(), repo, workflow, ref, stagingUrl: origin });
  });
  return out;
}

let targetsCache: { json: string; targets: RebuildTarget[] } | null = null;
export function rebuildTargets(): RebuildTarget[] {
  const json = config.webdeskRebuild.targetsJson;
  if (!targetsCache || targetsCache.json !== json) targetsCache = { json, targets: parseRebuildTargets(json) };
  return targetsCache.targets;
}

export function rebuildTargetFor(tenantSlug: string, siteId: string): RebuildTarget | null {
  const id = siteId.toLowerCase();
  return rebuildTargets().find((t) => t.siteId === id && t.tenantSlug === tenantSlug) ?? null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The ledger (all access: tenant + the `webdev` module scope — the third wall)
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const inWebdev = <T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
  withTenants([tenantId], fn, { modules: ["webdev"] });

interface BuildRow {
  id: string;
  approval_id: string | null;
  kind: BuildKind;
  state: BuildState;
  requested_at: Date;
  dispatched_at: Date | null;
  published_at: Date | null;
  staging_url: string | null;
  verified_at: Date | null;
  failure_reason: string | null;
  site_id: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What the editor reads. The newest build for the site, and whether staging still shows taken-down content. */
export async function getBuildStatus(tenantId: string, tenantSlug: string, siteId: string): Promise<BuildStatusBody> {
  const { build, stale } = await inWebdev(tenantId, async (c) => {
    const b = await c.query<BuildRow>(
      `SELECT id, approval_id, kind, state, requested_at, dispatched_at, published_at, staging_url, verified_at, failure_reason, site_id
         FROM webdev_site_builds
        WHERE tenant_id = $1 AND site_id = $2 AND tenant_slug = $3
        ORDER BY requested_at DESC, id DESC
        LIMIT 1`,
      [tenantId, siteId, tenantSlug],
    );
    const m = await c.query<{ stale_since: Date | null }>(
      `SELECT stale_since FROM webdev_site_staging_marks WHERE tenant_id = $1 AND site_id = $2`,
      [tenantId, siteId],
    );
    return { build: b.rows[0] ?? null, stale: m.rows[0]?.stale_since != null };
  });
  return {
    build: build
      ? {
          approvalId: build.approval_id,
          kind: build.kind,
          requestedAt: build.requested_at.toISOString(),
          publishedAt: iso(build.published_at),
          state: build.state,
          stagingUrl: build.staging_url,
          verifiedAt: iso(build.verified_at),
        }
      : null,
    stagingStale: stale,
  };
}

/** The typed reason of a site's newest failed build, for operator surfaces (the approval's execution
 *  result carries the same token). Not part of the editor's wire shape. */
export async function getLatestFailureReason(tenantId: string, siteId: string): Promise<string | null> {
  return inWebdev(tenantId, async (c) => {
    const r = await c.query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM webdev_site_builds
        WHERE tenant_id = $1 AND site_id = $2 ORDER BY requested_at DESC, id DESC LIMIT 1`,
      [tenantId, siteId],
    );
    return r.rows[0]?.failure_reason ?? null;
  });
}

/** Content was taken down (unpublish/delete): staging keeps showing it until the next rebuild. Idempotent;
 *  keeps the EARLIEST instant while the marker is set. Called by the unpublish/delete handler (WSK-59). */
export async function noteStagingStale(tenantId: string, siteId: string): Promise<void> {
  await inWebdev(tenantId, (c) =>
    c.query(
      `INSERT INTO webdev_site_staging_marks (tenant_id, site_id, stale_since) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id, site_id)
       DO UPDATE SET stale_since = COALESCE(webdev_site_staging_marks.stale_since, now()), updated_at = now()`,
      [tenantId, siteId],
    ),
  );
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Dispatch
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export interface StartRebuildInput {
  /** The company the approval was filed under (the ledger's tenant). */
  tenantId: string;
  tenantSlug: string;
  siteId: string;
  /** The approval whose decision authorises this dispatch (WSK-D46 / R3). */
  approvalId: string;
  kind: BuildKind;
  /** The newest `publishedAt` Zone B reported (publish only); null when unknown. */
  publishedAt: string | null;
  /** The human who decided the approval. Authorised against `github_repo · deploy`. null (WSK-61's
   *  scheduled publish only) = the decider can no longer be assembled: the row is recorded `failed`,
   *  reason `decider_inactive`, and nothing is dispatched. */
  decider: Principal | null;
  /** Recorded as `decided_by` when `decider` is null. */
  decidedBy?: string | null;
  /** WSK-D63: set ONLY by the approved-command executor when the decider of an executed publish is a CLIENT editor. The dispatch
   *  then re-verifies it server-side instead of running `authorizeDeploy` (see `ClientPublishAuthority`). Never passed for a staff
   *  decider, for a `rebuild`, or for a scheduled publish. */
  authority?: ClientPublishAuthority;
}

export interface StartRebuildResult {
  buildId: string | null;
  state: BuildState;
  failureReason: BuildFailureReason | null;
  /** true when this approval already had a build and NOTHING was dispatched. */
  deduplicated: boolean;
}

function parsedInstant(v: string | null): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
}

async function markFailed(tenantId: string, buildId: string, reason: BuildFailureReason): Promise<void> {
  await inWebdev(tenantId, (c) =>
    c.query(
      `UPDATE webdev_site_builds SET state = 'failed', failure_reason = $3, updated_at = now()
        WHERE id = $2 AND tenant_id = $1 AND state = 'rebuilding'`,
      [tenantId, buildId, reason],
    ),
  );
}

/**
 * Claim a build row for the approval and dispatch ONE workflow run. Never throws.
 *
 * Idempotent per approval: a second call finds the first's row and returns it untouched (the dispatch is
 * not repeated), whatever state it is in.
 */
export async function startSiteRebuild(input: StartRebuildInput): Promise<StartRebuildResult> {
  const target = rebuildTargetFor(input.tenantSlug, input.siteId);
  const refusal: BuildFailureReason | null = !target ? "rebuild_not_configured" : input.decider === null ? "decider_inactive" : null;
  let buildId: string | null = null;
  try {
    const id = newId();
    const inserted = await inWebdev(input.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO webdev_site_builds
           (id, tenant_id, tenant_slug, site_id, approval_id, kind, state, published_at, repo, ref, staging_url, decided_by, failure_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, approval_id) DO NOTHING
         RETURNING id`,
        [
          id, input.tenantId, input.tenantSlug, input.siteId, input.approvalId, input.kind,
          refusal ? "failed" : "rebuilding",
          parsedInstant(input.publishedAt),
          target?.repo ?? null, target?.ref ?? null, target?.stagingUrl ?? null,
          input.decider ? (input.decider.userId ?? null) : (input.decidedBy ?? null),
          refusal,
        ],
      );
      if (r.rows[0]) return { won: true as const };
      const existing = await c.query<{ id: string; state: BuildState; failure_reason: BuildFailureReason | null }>(
        `SELECT id, state, failure_reason FROM webdev_site_builds WHERE tenant_id = $1 AND approval_id = $2`,
        [input.tenantId, input.approvalId],
      );
      return { won: false as const, existing: existing.rows[0] };
    });
    if (!inserted.won) {
      const e = inserted.existing;
      return { buildId: e?.id ?? null, state: e?.state ?? "failed", failureReason: e?.failure_reason ?? null, deduplicated: true };
    }
    buildId = id;
  } catch (err) {
    logger.error(`rebuild ledger write failed for approval ${input.approvalId}: ${(err as Error).message}`);
    return { buildId: null, state: "failed", failureReason: "build_ledger_unavailable", deduplicated: false };
  }

  if (!target || input.decider === null) {
    logger.warn(
      !target
        ? `approval ${input.approvalId}: no rebuild target is configured for site ${input.siteId}`
        : `approval ${input.approvalId}: the decider is no longer active; nothing dispatched`,
    );
    return { buildId, state: "failed", failureReason: refusal, deduplicated: false };
  }
  const decider = input.decider;

  // The dispatch, bounded: decide() must not hang on a GitHub that is slow or rate-limiting us.
  let deadline: NodeJS.Timeout | undefined;
  const raced = await Promise.race([
    dispatchApprovedWorkflow({
      decider,
      requestTenantId: input.tenantId,
      approvalId: input.approvalId,
      repo: target.repo,
      workflow: target.workflow,
      ref: target.ref,
      ...(input.authority ? { authority: input.authority } : {}),
      inputs: {
        approval_id: input.approvalId,
        kind: input.kind,
        ...(input.publishedAt ? { published_at: input.publishedAt } : {}),
      },
    }).then(
      (ok) => ({ tag: "ok" as const, ok }),
      (error: unknown) => ({ tag: "err" as const, error }),
    ),
    new Promise<{ tag: "deadline" }>((resolve) => {
      deadline = setTimeout(() => resolve({ tag: "deadline" }), config.webdeskRebuild.dispatchDeadlineMs);
    }),
  ]);
  if (deadline) clearTimeout(deadline);

  try {
    if (raced.tag === "ok") {
      await inWebdev(input.tenantId, (c) =>
        c.query(
          `UPDATE webdev_site_builds
              SET dispatched_at = now(), github_correlation_id = $3, updated_at = now()
            WHERE id = $2 AND tenant_id = $1 AND state = 'rebuilding'`,
          [input.tenantId, buildId, raced.ok.correlationId],
        ),
      );
      return { buildId, state: "rebuilding", failureReason: null, deduplicated: false };
    }
    const reason: BuildFailureReason =
      raced.tag === "deadline"
        ? "dispatch_unconfirmed"
        : raced.error instanceof WorkflowDispatchError
          ? raced.error.reason
          : "github_dispatch_failed";
    if (raced.tag === "err" && !(raced.error instanceof WorkflowDispatchError)) {
      logger.error(`approval ${input.approvalId}: unexpected dispatch error: ${(raced.error as Error)?.name ?? "error"}`);
    } else {
      logger.warn(`approval ${input.approvalId}: staging rebuild not dispatched (${reason})`);
    }
    await markFailed(input.tenantId, buildId, reason);
    return { buildId, state: "failed", failureReason: reason, deduplicated: false };
  } catch (err) {
    // The dispatch happened (or not) but the row could not be updated. The sweeper fails a row that
    // never got a dispatch time, so the ledger converges on "failed: dispatch_unconfirmed", never "live".
    logger.error(`approval ${input.approvalId}: could not record the dispatch outcome: ${(err as Error).message}`);
    return { buildId, state: "rebuilding", failureReason: null, deduplicated: false };
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The stamp poll
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type PollOutcome = "live" | "unverified" | "rebuilding" | "skipped";

export interface PollOptions extends StampFetchOptions {
  /** Injected clock for the window check. Defaults to now. */
  now?: Date;
  windowMs?: number;
}

/** Poll ONE build's stamp once and settle it if the stamp (or the window) decides it. */
export async function pollSiteBuild(tenantId: string, buildId: string, opts: PollOptions = {}): Promise<PollOutcome> {
  const row = await inWebdev(tenantId, async (c) => {
    const r = await c.query<BuildRow & { poll_count: number }>(
      `SELECT id, approval_id, kind, state, requested_at, dispatched_at, published_at, staging_url, verified_at, failure_reason, site_id, poll_count
         FROM webdev_site_builds WHERE id = $2 AND tenant_id = $1`,
      [tenantId, buildId],
    );
    return r.rows[0] ?? null;
  });
  if (!row || row.state !== "rebuilding" || !row.dispatched_at || !row.staging_url) return "skipped";

  const read = await readStagingStamp(row.staging_url, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    nonce: `${buildId}-${row.poll_count + 1}`,
  });
  const proof = read.ok
    ? stampProves(read.stamp, { kind: row.kind, publishedAt: row.published_at, dispatchedAt: row.dispatched_at })
    : ({ proved: false, why: `stamp unreadable (${read.reason})` } as const);

  const now = opts.now ?? new Date();
  const windowMs = opts.windowMs ?? config.webdeskRebuild.pollWindowMs;
  const expired = now.getTime() >= row.dispatched_at.getTime() + windowMs;
  const next: "live" | "unverified" | null = proof.proved ? "live" : expired ? "unverified" : null;

  return inWebdev(tenantId, async (c) => {
    // The state guard makes a settle single-winner: a concurrent poll (or a second process) cannot flip
    // a settled row, and `live` can only be written by the branch that holds a proof.
    const stamp = read.ok ? read.stamp : null;
    const upd = await c.query<{ dispatched_at: Date }>(
      `UPDATE webdev_site_builds
          SET last_polled_at = now(), poll_count = poll_count + 1,
              last_stamp_pulled_at = COALESCE($3, last_stamp_pulled_at),
              last_stamp_max_updated_at = COALESCE($4, last_stamp_max_updated_at),
              state = COALESCE($5, state),
              verified_at = CASE WHEN $5 = 'live' THEN now() ELSE verified_at END,
              updated_at = now()
        WHERE id = $2 AND tenant_id = $1 AND state = 'rebuilding'
        RETURNING dispatched_at`,
      [tenantId, buildId, stamp?.pulledAt ?? null, stamp?.maxUpdatedAt ?? null, next],
    );
    if (!upd.rows[0]) return "skipped" as const;
    if (next === "live") {
      await c.query(
        `UPDATE webdev_site_staging_marks SET stale_since = NULL, updated_at = now()
          WHERE tenant_id = $1 AND site_id = $2 AND stale_since IS NOT NULL AND stale_since <= $3`,
        [tenantId, row.site_id, upd.rows[0].dispatched_at],
      );
    }
    return next ?? ("rebuilding" as const);
  });
}

/** How long a row may sit `rebuilding` with no dispatch time before it is failed as unconfirmed. */
const ORPHAN_AFTER_MS = 5 * 60_000;

export interface SweepResult {
  considered: number;
  polled: number;
  live: number;
  unverified: number;
  orphansFailed: number;
}

/** One pass over every webdev-enabled company: fail orphaned rows, poll due ones. */
export async function sweepSiteBuilds(opts: PollOptions = {}): Promise<SweepResult> {
  const out: SweepResult = { considered: 0, polled: 0, live: 0, unverified: 0, orphansFailed: 0 };
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`));
  for (const co of companies.rows) {
    // The same question the monitoring runner asks: declaring the module scope is not the same as the
    // tenant having the module, so a background job must ask isModuleEnabled itself.
    if (!(await isModuleEnabled(co.id, "webdev"))) continue;
    const due = await inWebdev(co.id, async (c) => {
      const orphans = await c.query(
        `UPDATE webdev_site_builds SET state = 'failed', failure_reason = 'dispatch_unconfirmed', updated_at = now()
          WHERE tenant_id = $1 AND state = 'rebuilding' AND dispatched_at IS NULL AND requested_at < now() - ($2::int * interval '1 millisecond')`,
        [co.id, ORPHAN_AFTER_MS],
      );
      out.orphansFailed += orphans.rowCount ?? 0;
      const r = await c.query<{ id: string }>(
        `SELECT id FROM webdev_site_builds
          WHERE tenant_id = $1 AND state = 'rebuilding' AND dispatched_at IS NOT NULL
            AND (last_polled_at IS NULL OR last_polled_at <= now() - ($2::int * interval '1 millisecond'))
          ORDER BY requested_at`,
        [co.id, Math.max(1, Math.floor(config.webdeskRebuild.pollIntervalMs * 0.9))],
      );
      return r.rows;
    });
    out.considered += due.length;
    for (const b of due) {
      try {
        const o = await pollSiteBuild(co.id, b.id, opts);
        if (o !== "skipped") out.polled++;
        if (o === "live") out.live++;
        if (o === "unverified") out.unverified++;
      } catch (err) {
        logger.error(`poll of build ${b.id} failed: ${(err as Error).message}`);
      }
    }
  }
  return out;
}

/** The poll loop. Chained setTimeout (a slow sweep cannot overlap itself), the monitoring runner's shape.
 *  Started by main.ts only when a rebuild target is configured: it polls nothing otherwise.
 *  `beforeSweep` (WSK-61: the scheduled-publish settle) runs first in each tick, so a build it starts is
 *  polled from the next tick on; its failure is logged and never stops the poll. */
export function startSiteBuildsLoop(intervalMs: number, opts: { beforeSweep?: () => Promise<unknown> } = {}): { stop: () => void } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.error(`refusing to start the site-builds poller: intervalMs=${intervalMs} is not positive`);
    return { stop: () => undefined };
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    if (opts.beforeSweep) {
      try {
        await opts.beforeSweep();
      } catch (err) {
        logger.error(`pre-sweep step failed: ${(err as Error).message}`);
      }
    }
    try {
      const r = await sweepSiteBuilds();
      if (r.polled > 0 || r.orphansFailed > 0) logger.log(`sweep: ${JSON.stringify(r)}`);
    } catch (err) {
      logger.error(`sweep failed: ${(err as Error).message}`);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
