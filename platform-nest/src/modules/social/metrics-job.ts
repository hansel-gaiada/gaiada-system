// SMM-21 — `pullMetrics`: the nightly analytics ingest into `social_metrics_daily` (per-account
// daily series) and `social_post_metrics` (per-post append-only snapshots), the read source behind
// the console's Analytics tab.
//
// SHAPE mirrors `post-status-sync-job.ts` (SMM-10) deliberately, because it shares the same real
// constraint that job already solved: reading/writing our own schema must run inside a declared
// module scope (0105's third RLS wall), but the ACTUAL network call to the publisher engine must
// run OUTSIDE any transaction — a slow/failing driver call held inside a transaction would turn
// one tenant's metrics pull into a stalled connection for every other query on it. So each half
// below reads (own declared-scope transaction) → calls the driver (no transaction) → writes (own
// declared-scope transaction), the same three-step shape `reconcileTenantPostStatus` uses.
//
// pullMetrics runs in two independent halves so one failing does not starve the other:
//   (A) ACCOUNT DAILY METRICS — one `getAccountMetrics` call per connected account (the port has
//       no multi-account batching for this call, unlike `getPostStatus`), upserted into
//       `social_metrics_daily` via its own `UNIQUE(account_id, date)` — re-running a day is an
//       UPDATE, never a duplicate (0105's own design comment on that constraint).
//   (B) POST METRICS — one `getPostMetrics` call per (publisher org, batch of published
//       provider_post_ids), APPENDED — never upserted — into `social_post_metrics`, which 0105
//       designs explicitly as an append-only snapshot history (`fetched_at` distinguishes runs).
//
// ── ⚠ THE MODULE GUC (recurring defect class #1 — every social job in this module gets bitten by
// it independently, so it is restated here rather than only cross-referenced) ────────────────────
// Every `social_*` table carries 0105's THIRD RLS wall: `app_module_allowed('social')`, which
// `withTenants([tenantId])` alone does NOT satisfy. `applyAccountDailyMetrics` and
// `appendPostMetrics` below each declare their OWN module scope via `declareSocialModuleScope`
// before touching a row — exactly like `applyPostStatuses`/`purgeTenantInboxRetention`. Delete
// either call and the corresponding query reads/writes ZERO ROWS, SILENTLY, and `runMetricsPull`
// would report "0 accounts, 0 posts, nothing to do" forever — the exact failure shape the ticket
// brief named ("a nightly metrics job would log '0 rows synced' forever and look perfectly
// healthy"). `metrics-job.test.ts`'s "(module GUC)" tests prove this: they call the apply
// functions exactly as written (no `{modules:['social']}` passed at the call site — the function
// itself is what declares it) and assert a REAL row exists afterward, the same proof shape
// `post-status-sync-job.test.ts`'s (T1) uses.
//
// ── ⚠ NO INVENTED NUMBERS ───────────────────────────────────────────────────────────────────────
// `DailyMetrics`/`PostMetrics` (`publisher/types.ts`) have every field OPTIONAL. A field the
// engine did not report is written as SQL NULL, never coerced to 0 — `social_metrics_daily`'s and
// `social_post_metrics`'s own columns are nullable integers for exactly this reason (0105's
// header). An absent counter must read as "we do not know", never as "zero happened", the same
// discipline `media-rules.ts`'s `quota_unknown` already holds the quota strip to. The Analytics
// tab (`platform-ui`) renders a missing metric as an explicit dash/"not yet fetched", never `0`.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { declareSocialModuleScope } from "./publish-precondition";
import { openOrg, type PublisherOrgRow } from "./publisher/provisioning";
import type { DailyMetrics, PostMetrics, DateRange } from "./publisher/types";
import { invokePublisher } from "./publisher/registry";

// ── reads (own transaction, own declared scope, no network I/O) ───────────────────────────────────

interface ConnectedAccountRow {
  id: string;
  org_id: string;
  network: string;
  postiz_integration_id: string;
}

async function loadOrg(c: PoolClient, orgId: string): Promise<PublisherOrgRow | null> {
  const { rows } = await c.query<PublisherOrgRow>(
    `SELECT id, client_id AS "clientId", driver, postiz_org_id AS "postizOrgId",
            api_key_ref AS "apiKeyRef", status
       FROM social_publisher_orgs WHERE id = $1 AND deleted_at IS NULL`,
    [orgId],
  );
  return rows[0] ?? null;
}

async function loadConnectedAccounts(c: PoolClient): Promise<ConnectedAccountRow[]> {
  const { rows } = await c.query<ConnectedAccountRow>(
    `SELECT id, publisher_org_id AS org_id, network, postiz_integration_id
       FROM social_accounts
      WHERE status = 'connected' AND postiz_integration_id IS NOT NULL AND deleted_at IS NULL`,
  );
  return rows;
}

/** Runtime lookback for the post-metrics half — an OPERATIONAL job parameter (how far back to
 *  keep refreshing an already-published post's engagement numbers), not a business metric or a
 *  quota constant, so the ticket's "no invented numbers" rule (which is about business/quota
 *  values a caller could mistake for something the engine told us) does not apply to it. 30 days
 *  is chosen so a post keeps refreshing while engagement is still realistically accruing, without
 *  re-pulling an engagement's entire lifetime history every single night. */
const POST_METRICS_LOOKBACK_DAYS = 30;

interface PublishedVariantRow {
  variant_id: string;
  provider_post_id: string;
  org_id: string;
}

async function loadRecentlyPublished(c: PoolClient, sinceDays: number): Promise<PublishedVariantRow[]> {
  const { rows } = await c.query<PublishedVariantRow>(
    `SELECT v.id AS variant_id, v.provider_post_id, a.publisher_org_id AS org_id
       FROM social_post_variants v
       JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
      WHERE v.status = 'published' AND v.provider_post_id IS NOT NULL AND v.deleted_at IS NULL
        AND v.published_at >= now() - make_interval(days => $1::int)`,
    [sinceDays],
  );
  return rows;
}

// ── writes (own transaction, own declared scope — see the module-GUC note above) ──────────────────

/** (A) Upsert one account's daily series. Declares its own module scope. `ON CONFLICT
 *  (account_id, date)` makes re-running an already-pulled day an UPDATE, never a duplicate. */
export async function applyAccountDailyMetrics(
  tenantId: string, accountId: string, series: DailyMetrics[],
): Promise<{ written: number }> {
  if (series.length === 0) return { written: 0 };
  let written = 0;
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    for (const d of series) {
      await c.query(
        `INSERT INTO social_metrics_daily
           (tenant_id, account_id, date, followers, impressions, reach, engagements, link_clicks,
            video_views, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (account_id, date) DO UPDATE SET
           followers = EXCLUDED.followers, impressions = EXCLUDED.impressions,
           reach = EXCLUDED.reach, engagements = EXCLUDED.engagements,
           link_clicks = EXCLUDED.link_clicks, video_views = EXCLUDED.video_views,
           raw = EXCLUDED.raw, updated_at = now()`,
        [
          tenantId, accountId, d.date,
          d.followers ?? null, d.impressions ?? null, d.reach ?? null, d.engagements ?? null,
          d.linkClicks ?? null, d.videoViews ?? null, JSON.stringify(d.raw ?? {}),
        ],
      );
      written += 1;
    }
  });
  return { written };
}

/** (B) Append post-metric snapshots. NEVER upserted — see the file header. Declares its own
 *  module scope. */
export async function appendPostMetrics(
  tenantId: string, rows: Array<{ variantId: string; metrics: PostMetrics }>,
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };
  let written = 0;
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    for (const { variantId, metrics: m } of rows) {
      await c.query(
        `INSERT INTO social_post_metrics
           (tenant_id, variant_id, impressions, likes, comments, shares, saves, video_views, clicks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tenantId, variantId,
          m.impressions ?? null, m.likes ?? null, m.comments ?? null, m.shares ?? null,
          m.saves ?? null, m.videoViews ?? null, m.clicks ?? null,
        ],
      );
      written += 1;
    }
  });
  return { written };
}

// ── one tenant's sweep ─────────────────────────────────────────────────────────────────────────

/** One tenant's pull, both halves. A single account's or org's driver failure is caught and
 *  logged (mirrors `reconcileTenantPostStatus`'s per-org isolation) so one client's outage never
 *  blocks pulling every other client's metrics. */
export async function pullTenantMetrics(
  tenantId: string, now: Date = new Date(),
): Promise<{ accounts: number; dailyRows: number; posts: number; postMetricRows: number; errors: number }> {
  let errors = 0;

  const orgCache = new Map<string, PublisherOrgRow | null>();
  const loadOrgCached = async (orgId: string): Promise<PublisherOrgRow | null> => {
    if (!orgCache.has(orgId)) {
      const org = await withTenants([tenantId], async (c) => {
        await declareSocialModuleScope(c);
        return loadOrg(c, orgId);
      });
      orgCache.set(orgId, org);
    }
    return orgCache.get(orgId) ?? null;
  };

  // ── (A) account daily metrics ────────────────────────────────────────────────────────────────
  const accounts = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadConnectedAccounts(c);
  });

  // 3-day window (today + 2 days back): comfortably covers a single missed nightly run without
  // re-walking a whole history every time. `getAccountMetrics` is itself an upsert-safe re-pull
  // (see (A) above), so a wider window than "just today" is free correctness, not waste.
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const range: DateRange = { from, to };

  let dailyRows = 0;
  for (const acct of accounts) {
    try {
      const org = await loadOrgCached(acct.org_id);
      if (!org) continue;
      const { driver, handle } = openOrg(org);
      if (!driver.capabilities.has("account_metrics")) continue;
      const series = await invokePublisher(
        { op: "getAccountMetrics", org: handle, network: acct.network },
        () => driver.getAccountMetrics(handle, acct.postiz_integration_id, range),
      );
      const result = await applyAccountDailyMetrics(tenantId, acct.id, series);
      dailyRows += result.written;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-METRICS-PULL] account ${acct.id} (tenant ${tenantId}) failed:`, (err as Error).message);
    }
  }

  // ── (B) post metrics ─────────────────────────────────────────────────────────────────────────
  const published = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadRecentlyPublished(c, POST_METRICS_LOOKBACK_DAYS);
  });
  const byOrg = new Map<string, PublishedVariantRow[]>();
  for (const r of published) {
    const list = byOrg.get(r.org_id) ?? [];
    list.push(r);
    byOrg.set(r.org_id, list);
  }

  let postMetricRows = 0;
  for (const [orgId, rows] of byOrg) {
    try {
      const org = await loadOrgCached(orgId);
      if (!org) continue;
      const { driver, handle } = openOrg(org);
      if (!driver.capabilities.has("post_metrics")) continue;
      const ids = rows.map((r) => r.provider_post_id);
      const metrics = await invokePublisher(
        { op: "getPostMetrics", org: handle },
        () => driver.getPostMetrics(handle, ids),
      );
      const byPostId = new Map(metrics.map((m) => [m.providerPostId, m]));
      const toWrite: Array<{ variantId: string; metrics: PostMetrics }> = [];
      for (const r of rows) {
        const m = byPostId.get(r.provider_post_id);
        if (m) toWrite.push({ variantId: r.variant_id, metrics: m });
      }
      const result = await appendPostMetrics(tenantId, toWrite);
      postMetricRows += result.written;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-METRICS-PULL] org ${orgId} post-metrics (tenant ${tenantId}) failed:`, (err as Error).message);
    }
  }

  return { accounts: accounts.length, dailyRows, posts: published.length, postMetricRows, errors };
}

/** Sweep every tenant. Mirrors `runInboxRetentionPurge`/`runPostStatusSync` verbatim: `withGlobal`
 *  for the company list (companies carry no tenant_id — they ARE the tenants), per-tenant
 *  failures logged and swallowed so one tenant's bad row/outage can never abort the sweep for
 *  every other tenant. */
export async function runMetricsPull(now: Date = new Date()): Promise<{
  tenants: number; accounts: number; dailyRows: number; posts: number; postMetricRows: number; errors: number;
}> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let accounts = 0;
  let dailyRows = 0;
  let posts = 0;
  let postMetricRows = 0;
  let errors = 0;
  for (const { id: tenantId } of tenants) {
    try {
      const r = await pullTenantMetrics(tenantId, now);
      accounts += r.accounts;
      dailyRows += r.dailyRows;
      posts += r.posts;
      postMetricRows += r.postMetricRows;
      errors += r.errors;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-METRICS-PULL] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, accounts, dailyRows, posts, postMetricRows, errors };
}

// ── env gate + loop ─────────────────────────────────────────────────────────────────────────────
//
// Read directly from `process.env` here, deliberately NOT via `config.ts`: that file (and
// `main.ts`) is held by SMM-38a's parallel worktree for the length of this ticket. Naming matches
// this module's existing `SOCIAL_*_ENABLED` / `SOCIAL_*_INTERVAL_MS` convention
// (`inbox-retention-job.ts`'s `SOCIAL_INBOX_RETENTION_PURGE_ENABLED`,
// `post-status-sync-job.ts`'s `SOCIAL_RECONCILE_ENABLED`) so a later pass folding this into
// `config.social` is a mechanical rename, not a redesign. Dark by default, like every other job in
// this module.

export function socialMetricsPullEnabled(): boolean {
  return process.env.SOCIAL_METRICS_PULL_ENABLED === "1" || process.env.SOCIAL_METRICS_PULL_ENABLED === "true";
}

export function socialMetricsPullIntervalMs(): number {
  return Number(process.env.SOCIAL_METRICS_PULL_INTERVAL_MS ?? 24 * 3600 * 1000);
}

/** Daily loop. Only started by main.ts when `socialMetricsPullEnabled()` is true — see this
 *  file's header for why the gate lives here instead of in `config.ts`. */
export function startMetricsPullLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runMetricsPull();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-METRICS-PULL] sweep run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-METRICS-PULL] tick failed:", (err as Error).message);
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
