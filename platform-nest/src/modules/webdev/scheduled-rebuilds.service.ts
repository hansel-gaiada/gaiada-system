// WSK-61 — a scheduled publish going live rebuilds staging, under the schedule's OWN approval.
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §9 + §12 WSK-61. Ledger: WSK-60
// (site-builds.service.ts). Migration: 202610110441_webdev_schedule_firings.sql.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// A `content.schedule` approval executes at decide() and publishes NOTHING yet (WSK-66 does not
// rebuild for it). Zone B makes it public later, BY TIME: its read path serves a `scheduled` item once
// publish_at <= now(), and drops any item at unpublish_at, whether or not the content tick has run. So
// at publishAt the staging site is behind, and at unpublishAt it shows content production no longer
// serves. This file closes both gaps:
//
//   publish    every item is live at the approved version → ONE `startSiteRebuild` under the
//              schedule's approval id, as its decider (D46 R3: the approval authorises the rebuild;
//              D14: a deferred effect re-drives as the original decider, never as a system account)
//   unpublish  at least one item went down → staging is marked stale ONCE (noteStagingStale's own SQL,
//              in the same transaction as the settle row, so it cannot repeat after a rebuild clears it)
//
// ── THE EVENT IS A HINT, NEVER AUTHORITY (§03 channel 1) ─────────────────────────────────────────
// WebDesk's tick emits `schedule.fired` (zoneb-event-schema.ts). The controller hands its `siteId` and
// `approvalId` here and NOTHING ELSE: they only narrow which of THIS company's own executed schedules to
// re-check, and a `superseded` settle may be re-checked when an event names its approval. What gets
// dispatched is decided by (a) the company's own approval rows, (b) the stored args matching their
// filed command hash, and (c) a fresh control-channel read of every item. A forged event (another
// company's site, an invented approval, a replay) finds nothing to settle or re-reads a state that does
// not satisfy (c): noise. The SWEEP (startSiteBuildsLoop's pre-sweep step) is the primary path; a lost
// or duplicated event costs at most one tick of latency.
//
// ── EXACTLY ONCE ─────────────────────────────────────────────────────────────────────────────────
// The dispatch: `webdev_site_builds` UNIQUE (tenant_id, approval_id) (startSiteRebuild claims the row
// before it dispatches, so an event racing the sweep still yields one dispatch). The stale mark:
// `webdev_schedule_firings` UNIQUE (tenant_id, approval_id, transition); only the INSERT that wins marks.
// A FAILED build row is terminal by design (the ledger admits one build per approval): `deploy_denied`,
// `decider_inactive`, `rebuild_not_configured` and the dispatch's own failures are all shown to the
// editor as a failed build, and the remedy is a `content.rebuild` approval, never a silent retry.
//
// ── WHEN A SCHEDULE DOES NOT VISIBLY TAKE EFFECT ─────────────────────────────────────────────────
// Before effectiveAt + WEBDESK_SCHEDULE_SUPERSEDE_GRACE_MS (default 15 min) a publish fires only when
// EVERY item is live at its approved version. A version SWAP of a live item needs the tick, so a slow
// tick looks like "live at another version" until it runs. After the grace window: at least one item
// live at its version → dispatch (the content went public; a straggler is the editor's content.rebuild);
// none → `superseded` (deleted, unpublished, or replaced by a later publish that rebuilt on its own). An
// event naming the approval re-checks a superseded publish, so a swap later than the grace window still
// rebuilds. A takedown marks stale once any item is down (all down: at once; some: after the grace); all
// still live after the grace → `superseded`. Effective instants older than SCHEDULE_SWEEP_WINDOW_MS are
// settled `expired` without a read.
//
// ── IndexNow (M5-P5a2) ───────────────────────────────────────────────────────────────────────────
// A schedule going live (or coming down) is also what search engines must hear about. settlePublish pings
// IndexNow (transition `publish`, ref = the schedule's approval id, only the items read live at their approved
// version) and settleUnpublish pings (transition `unpublish`, only the items read down), via the search module's
// `notifyWebdeskTransition`, which re-reads the items itself and does nothing unless the tenant has IndexNow on.
// The ping is BEST-EFFORT and AT-LEAST-ONCE: it runs after the "did it take effect" read and BEFORE the settle
// row / the rebuild, so a crash, a `waiting` outcome or a failed settle re-pings on the next tick, and the search
// ledger's uniqueness on (property, engine, url, `transition:v<version>:<approvalId>`) turns every repeat into a
// no-op that sends nothing. A failing ping is logged and never changes the settle outcome or the counters; the
// publish ping does not depend on the staging rebuild succeeding (production serves the content by time either way).
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { withGlobal, withTenants } from "../../db";
import { assemblePrincipal } from "../../rbac/principal";
import { isModuleEnabled } from "../registry";
import { notifyWebdeskTransition, type WebdeskTransitionArgs } from "../search/indexnow-webdesk";
import { getWebdeskCommandControlClient, webdeskCommandHashFor } from "./webdesk-approved-command";
import type { WebdeskControlClient, WebdeskControlResponse } from "./webdesk-control-client";
import { startSiteRebuild } from "./site-builds.service";

const logger = new Logger("ScheduledRebuilds");

/** An effective instant older than this is settled `expired` without reading Zone B. */
export const SCHEDULE_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** At most this many schedules are settled per company per call; the rest are the next tick's. */
const MAX_SCHEDULES_PER_SETTLE = 50;
const ITEM_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId";

export type Transition = "publish" | "unpublish";
export type FiringOutcome = "build_recorded" | "superseded" | "stale_marked" | "expired" | "refused";

/** What an event may contribute: which site to look at, and which superseded publish to re-check. */
export interface SettleHint {
  siteId?: string | null;
  reopenApprovalIds?: string[];
}

export interface SettleOptions {
  /** Tests: the clock. */
  now?: Date;
}

export interface SettleResult {
  considered: number;
  /** A build row was claimed and the workflow dispatch accepted (or in flight). */
  dispatched: number;
  /** A build row was claimed and recorded `failed` (deploy_denied, decider_inactive, …): terminal. */
  failedBuilds: number;
  staleMarked: number;
  superseded: number;
  expired: number;
  refused: number;
  /** Not yet decidable (still inside the grace window, or Zone B could not be read). */
  waiting: number;
}

const inWebdev = <T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
  withTenants([tenantId], fn, { modules: ["webdev"] });

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

interface CandidateRow {
  id: string;
  tool_args: unknown;
  decided_by: string | null;
  publish_at: Date | null;
  unpublish_at: Date | null;
  publish_open: boolean;
  unpublish_open: boolean;
}

/**
 * The company's executed `content.schedule` approvals with a transition that is DUE and not settled.
 * `pg_input_is_valid` keeps one malformed instant from failing the whole query (PG 16+); the stored
 * args are re-validated against their command hash before anything is read or dispatched.
 */
async function dueSchedules(tenantId: string, hint: SettleHint): Promise<CandidateRow[]> {
  return inWebdev(tenantId, async (c) => {
    const r = await c.query<CandidateRow>(
      `WITH s AS (
         SELECT a.id, a.tool_args, a.decided_by, a.decided_at,
                CASE WHEN pg_input_is_valid(a.tool_args->>'publishAt', 'timestamptz')
                     THEN (a.tool_args->>'publishAt')::timestamptz END AS publish_at,
                CASE WHEN pg_input_is_valid(a.tool_args->>'unpublishAt', 'timestamptz')
                     THEN (a.tool_args->>'unpublishAt')::timestamptz END AS unpublish_at
           FROM automation_approvals a
          WHERE a.tenant_id = $1 AND a.origin = 'webdesk' AND a.workflow_id = 'content.schedule'
            AND a.status = 'approved' AND a.execution_status = 'executed' AND a.deleted_at IS NULL
            AND ($2::text IS NULL OR lower(a.tool_args->>'siteId') = lower($2::text))
       ), d AS (
         SELECT s.*,
                (s.publish_at <= now()
                  AND NOT EXISTS (SELECT 1 FROM webdev_site_builds b WHERE b.tenant_id = $1 AND b.approval_id = s.id)
                  AND NOT EXISTS (SELECT 1 FROM webdev_schedule_firings f
                                   WHERE f.tenant_id = $1 AND f.approval_id = s.id AND f.transition = 'publish'
                                     AND NOT (f.outcome = 'superseded' AND s.id = ANY($3::uuid[])))) AS publish_open,
                (s.unpublish_at <= now()
                  AND NOT EXISTS (SELECT 1 FROM webdev_schedule_firings f
                                   WHERE f.tenant_id = $1 AND f.approval_id = s.id AND f.transition = 'unpublish')) AS unpublish_open
           FROM s
       )
       SELECT id, tool_args, decided_by, publish_at, unpublish_at,
              COALESCE(publish_open, false) AS publish_open, COALESCE(unpublish_open, false) AS unpublish_open
         FROM d
        WHERE publish_open OR unpublish_open
        ORDER BY LEAST(publish_at, unpublish_at), id
        LIMIT $4`,
      [tenantId, hint.siteId ?? null, hint.reopenApprovalIds ?? [], MAX_SCHEDULES_PER_SETTLE],
    );
    return r.rows;
  });
}

interface Schedule {
  approvalId: string;
  tenantSlug: string;
  siteId: string;
  items: Array<{ itemId: string; version: number }>;
}

/** The stored args, only if they still match the hash the human approved (the WSK-66 tamper check). */
function scheduleOf(row: CandidateRow): Schedule | null {
  const a = row.tool_args;
  try {
    if (!isObj(a) || a.command !== "content.schedule" || webdeskCommandHashFor(a) !== a.commandHash) return null;
  } catch {
    return null;
  }
  return {
    approvalId: row.id,
    tenantSlug: a.tenantSlug as string,
    siteId: a.siteId as string,
    items: (a.items as Array<{ itemId: string; version: number }>).map(({ itemId, version }) => ({ itemId, version })),
  };
}

/** The version production serves for this item at `now` (Zone B's LIVE_SQL, restated), or null. */
export function liveVersionOf(item: Record<string, unknown>, now: number): number | null {
  if (item.deletedAt !== null && item.deletedAt !== undefined) return null;
  if (typeof item.publishedVersion !== "number") return null;
  const at = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const publishAt = at(item.publishAt);
  const unpublishAt = at(item.unpublishAt);
  if (unpublishAt !== null && unpublishAt <= now) return null;
  if (item.publishState === "published") return item.publishedVersion;
  if (item.publishState === "scheduled" && publishAt !== null && publishAt <= now) return item.publishedVersion;
  return null;
}

/** What a settled transition calls to ping IndexNow (M5-P5a2). Swappable so a test can observe or break it. */
let notifyIndexNow: (tenantId: string, a: WebdeskTransitionArgs) => Promise<unknown> = (tenantId, a) => notifyWebdeskTransition(tenantId, a);

/** Tests: replace the IndexNow notifier (null restores the real one). */
export function setScheduleIndexNowNotifierForTests(fn: ((tenantId: string, a: WebdeskTransitionArgs) => Promise<unknown>) | null): void {
  notifyIndexNow = fn ?? ((tenantId, a) => notifyWebdeskTransition(tenantId, a));
}

/** Best-effort, awaited: never throws, never touches the settle outcome. Logs ids and the error name only. */
async function pingIndexNow(tenantId: string, s: Schedule, transition: Transition, items: Schedule["items"]): Promise<void> {
  try {
    await notifyIndexNow(tenantId, { tenantSlug: s.tenantSlug, siteId: s.siteId, transition, ref: s.approvalId, items });
  } catch (err) {
    logger.warn(`schedule ${s.approvalId}: IndexNow ${transition} ping failed (${(err as Error)?.name ?? "error"}); the next tick retries`);
  }
}

/** Each item's live version (null = not live, incl. a 404), or null for the whole read when any read
 *  failed: the settle then waits for the next tick rather than guessing. Reads only. */
async function readLiveVersions(client: WebdeskControlClient, s: Schedule, now: number): Promise<Array<number | null> | null> {
  const out: Array<number | null> = [];
  for (const it of s.items) {
    let res: WebdeskControlResponse;
    try {
      res = await client.send({
        command: "item.get",
        method: "GET",
        path: ITEM_PATH,
        params: { tenantSlug: s.tenantSlug, siteId: s.siteId, itemId: it.itemId },
      });
    } catch {
      return null;
    }
    if (res.status === 404) {
      out.push(null);
      continue;
    }
    if (res.status !== 200 || !isObj(res.json) || !isObj(res.json.item)) return null;
    out.push(liveVersionOf(res.json.item, now));
  }
  return out;
}

async function recordFiring(
  tenantId: string,
  s: { approvalId: string; tenantSlug: string | null; siteId: string | null },
  transition: Transition,
  outcome: Exclude<FiringOutcome, "build_recorded" | "stale_marked">,
  effectiveAt: Date,
  detail: string,
): Promise<void> {
  await inWebdev(tenantId, (c) =>
    c.query(
      `INSERT INTO webdev_schedule_firings (tenant_id, approval_id, tenant_slug, site_id, transition, outcome, effective_at, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, approval_id, transition) DO NOTHING`,
      [tenantId, s.approvalId, s.tenantSlug, s.siteId, transition, outcome, effectiveAt, detail],
    ),
  );
}

async function settlePublish(
  tenantId: string,
  s: Schedule,
  decidedBy: string | null,
  effectiveAt: Date,
  client: WebdeskControlClient,
  now: number,
  out: SettleResult,
): Promise<void> {
  const live = await readLiveVersions(client, s, now);
  if (!live) {
    out.waiting++;
    return;
  }
  const n = s.items.length;
  const atVersion = s.items.filter((it, i) => live[i] === it.version).length;
  const detail = `items_live=${atVersion}/${n}`;
  const graceOver = now >= effectiveAt.getTime() + config.webdeskSchedule.supersedeGraceMs;
  if (atVersion < n && !graceOver) {
    out.waiting++;
    return;
  }
  if (atVersion === 0) {
    await recordFiring(tenantId, s, "publish", "superseded", effectiveAt, detail);
    out.superseded++;
    return;
  }
  // M5-P5a2: production already serves these by time, whatever the staging rebuild does next.
  await pingIndexNow(tenantId, s, "publish", s.items.filter((it, i) => live[i] === it.version));
  // As the DECIDER, at "linked" assurance (a verified identity, no fresh login: the honest value for a
  // deferred effect). null when the user is no longer active → a typed failed build, nothing dispatched.
  const decider = decidedBy ? await assemblePrincipal(decidedBy, "linked") : null;
  const r = await startSiteRebuild({
    tenantId,
    tenantSlug: s.tenantSlug,
    siteId: s.siteId,
    approvalId: s.approvalId,
    kind: "publish",
    // The stamp then proves the build by pulledAt ≥ dispatchedAt, which is exact here: the dispatch
    // happens only after every counted item was READ live, so any pull after it contains them.
    publishedAt: null,
    decider,
    decidedBy,
  });
  if (!r.buildId) {
    // The ledger could not be written: nothing was dispatched and nothing is recorded; next tick retries.
    out.waiting++;
    return;
  }
  await inWebdev(tenantId, (c) =>
    c.query(
      `INSERT INTO webdev_schedule_firings (tenant_id, approval_id, tenant_slug, site_id, transition, outcome, build_id, effective_at, detail)
       VALUES ($1, $2, $3, $4, 'publish', 'build_recorded', $5, $6, $7)
       ON CONFLICT (tenant_id, approval_id, transition) DO UPDATE
         SET outcome = 'build_recorded', build_id = EXCLUDED.build_id, detail = EXCLUDED.detail, updated_at = now()
         WHERE webdev_schedule_firings.outcome = 'superseded'`,
      [tenantId, s.approvalId, s.tenantSlug, s.siteId, r.buildId, effectiveAt, `${detail};build=${r.state}`],
    ),
  );
  if (!r.deduplicated) {
    if (r.state === "failed") out.failedBuilds++;
    else out.dispatched++;
  }
}

async function settleUnpublish(
  tenantId: string,
  s: Schedule,
  effectiveAt: Date,
  client: WebdeskControlClient,
  now: number,
  out: SettleResult,
): Promise<void> {
  const live = await readLiveVersions(client, s, now);
  if (!live) {
    out.waiting++;
    return;
  }
  const n = s.items.length;
  const down = live.filter((v) => v === null).length;
  const detail = `items_down=${down}/${n}`;
  const graceOver = now >= effectiveAt.getTime() + config.webdeskSchedule.supersedeGraceMs;
  if (down < n && !graceOver) {
    out.waiting++;
    return;
  }
  if (down === 0) {
    await recordFiring(tenantId, s, "unpublish", "superseded", effectiveAt, detail);
    out.superseded++;
    return;
  }
  // M5-P5a2: BEFORE the settle row, deliberately (at-least-once; the search ledger absorbs a repeat).
  await pingIndexNow(tenantId, s, "unpublish", s.items.filter((_, i) => live[i] === null));
  // The settle row and the mark in ONE transaction: only the INSERT that wins marks, so a mark that a
  // later rebuild cleared is never set again by a replayed event or a second sweep.
  const marked = await inWebdev(tenantId, async (c) => {
    const won = await c.query(
      `INSERT INTO webdev_schedule_firings (tenant_id, approval_id, tenant_slug, site_id, transition, outcome, effective_at, detail)
       VALUES ($1, $2, $3, $4, 'unpublish', 'stale_marked', $5, $6)
       ON CONFLICT (tenant_id, approval_id, transition) DO NOTHING
       RETURNING id`,
      [tenantId, s.approvalId, s.tenantSlug, s.siteId, effectiveAt, detail],
    );
    if (!won.rows[0]) return false;
    // noteStagingStale's statement (site-builds.service.ts), on this transaction's client.
    await c.query(
      `INSERT INTO webdev_site_staging_marks (tenant_id, site_id, stale_since) VALUES ($1, $2, now())
       ON CONFLICT (tenant_id, site_id)
       DO UPDATE SET stale_since = COALESCE(webdev_site_staging_marks.stale_since, now()), updated_at = now()`,
      [tenantId, s.siteId],
    );
    return true;
  });
  if (marked) out.staleMarked++;
}

/**
 * Settle every DUE transition of this company's executed schedules (optionally one site's). Never
 * throws for a single schedule: a failure is logged and the schedule is retried next tick.
 */
export async function settleScheduledRebuilds(tenantId: string, hint: SettleHint = {}, opts: SettleOptions = {}): Promise<SettleResult> {
  const out: SettleResult = { considered: 0, dispatched: 0, failedBuilds: 0, staleMarked: 0, superseded: 0, expired: 0, refused: 0, waiting: 0 };
  const rows = await dueSchedules(tenantId, hint);
  if (rows.length === 0) return out;
  let client: WebdeskControlClient | null = null;
  try {
    client = getWebdeskCommandControlClient();
  } catch {
    client = null; // not configured: nothing can be read, so nothing is settled (expired/refused still are)
  }
  const now = (opts.now ?? new Date()).getTime();
  for (const row of rows) {
    out.considered++;
    try {
      const s = scheduleOf(row);
      const due: Array<[Transition, Date]> = [];
      if (row.publish_open && row.publish_at) due.push(["publish", row.publish_at]);
      if (row.unpublish_open && row.unpublish_at) due.push(["unpublish", row.unpublish_at]);
      for (const [transition, effectiveAt] of due) {
        if (!s) {
          // Nothing from these args is trusted, so the row names no site.
          logger.error(`schedule ${row.id}: stored args do not match the filed command hash; refused`);
          await recordFiring(tenantId, { approvalId: row.id, tenantSlug: null, siteId: null }, transition, "refused", effectiveAt, "args_tampered");
          out.refused++;
          continue;
        }
        if (effectiveAt.getTime() < now - SCHEDULE_SWEEP_WINDOW_MS) {
          await recordFiring(tenantId, s, transition, "expired", effectiveAt, "outside_sweep_window");
          out.expired++;
          continue;
        }
        if (!client) {
          out.waiting++;
          continue;
        }
        if (transition === "publish") await settlePublish(tenantId, s, row.decided_by, effectiveAt, client, now, out);
        else await settleUnpublish(tenantId, s, effectiveAt, client, now, out);
      }
    } catch (err) {
      out.waiting++;
      logger.error(`schedule ${row.id}: settle failed: ${(err as Error).message}`);
    }
  }
  return out;
}

/** One pass over every webdev-enabled company. Run by startSiteBuildsLoop before its poll (main.ts). */
export async function sweepScheduledRebuilds(opts: SettleOptions = {}): Promise<SettleResult> {
  const total: SettleResult = { considered: 0, dispatched: 0, failedBuilds: 0, staleMarked: 0, superseded: 0, expired: 0, refused: 0, waiting: 0 };
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`));
  for (const co of companies.rows) {
    if (!(await isModuleEnabled(co.id, "webdev"))) continue;
    try {
      const r = await settleScheduledRebuilds(co.id, {}, opts);
      for (const k of Object.keys(total) as Array<keyof SettleResult>) total[k] += r[k];
    } catch (err) {
      logger.error(`settle for company ${co.id} failed: ${(err as Error).message}`);
    }
  }
  if (total.dispatched || total.failedBuilds || total.staleMarked || total.superseded || total.expired || total.refused) {
    logger.log(`schedule sweep: ${JSON.stringify(total)}`);
  }
  return total;
}

// ── The event path: fire-and-forget, one run per company at a time, bursts coalesced ─────────────

const running = new Map<string, { again: SettleHint | null; done: Promise<void> }>();

function mergeHints(a: SettleHint | null, b: SettleHint): SettleHint {
  if (!a) return b;
  return {
    siteId: a.siteId && a.siteId === b.siteId ? a.siteId : null,
    reopenApprovalIds: [...new Set([...(a.reopenApprovalIds ?? []), ...(b.reopenApprovalIds ?? [])])],
  };
}

/**
 * A `schedule.fired` event was recorded: re-check this company's schedules soon. Never throws and
 * never blocks the caller (the event's HTTP answer does not wait on Zone B or GitHub). While a run for
 * the company is in flight, further requests coalesce into ONE follow-up run.
 */
export function requestScheduleSettle(tenantId: string, hint: SettleHint): void {
  const cur = running.get(tenantId);
  if (cur) {
    cur.again = mergeHints(cur.again, hint);
    return;
  }
  const entry: { again: SettleHint | null; done: Promise<void> } = { again: null, done: Promise.resolve() };
  entry.done = (async () => {
    let next: SettleHint | null = hint;
    while (next) {
      try {
        await settleScheduledRebuilds(tenantId, next);
      } catch (err) {
        logger.error(`event-driven settle for company ${tenantId} failed: ${(err as Error).message}`);
      }
      next = entry.again;
      entry.again = null;
    }
    running.delete(tenantId);
  })();
  running.set(tenantId, entry);
}

/** Tests: resolves when no event-driven settle is running for the company. */
export async function scheduleSettleIdleForTests(tenantId: string): Promise<void> {
  for (let e = running.get(tenantId); e; e = running.get(tenantId)) await e.done;
}
