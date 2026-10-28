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
// ── SCP-Sd: SIMULATED ACCOUNTS ARE PULLED THROUGH THE SIMULATOR, BY THIS SAME SWEEP ─────────────────────────────────
// An account with `social_accounts.simulated = true` is not asked of its org's engine. Both halves route it through the
// social simulator (`resolveSimulatedPublisher`, the one road; publisher/simulated-driver.ts answers from the pure generator in
// publisher/simulated-metrics.ts) and store the answer with `source = 'simulated'` through their OWN two writers
// (`applySimulatedDailyMetrics`, `appendSimulatedPostMetrics`), leaving the real writers' SQL untouched. A real account's path
// is exactly what it was, plus SCP-Sa2's reverse fence (the simulator now runs beside a real Postiz, owner ruling SCP-D9):
// before a real engine is asked, a simulated account, a `simulated:` integration id or a `simulated:` provider post id is
// refused (`simulated_account_on_real_publisher`) and counted as an error, never sent. While the switch is off a simulated account is skipped without an error and nothing simulated is
// written (the writers refuse too). The simulated post half writes one snapshot per variant per due day (1, 3 and 7 days after
// go-live), stamped `fetched_at = go-live + day`, and writes only the ones not already stored: it is idempotent, and a post
// that went live three days ago gets its day-1 and day-3 rows on the next run (the catch-up is inherent, not a second job).
// So the sweep can run as often as you like in dev (SOCIAL_METRICS_PULL_INTERVAL_MS): an hourly run costs one read per org
// and, once a post has its three rows, no write at all.
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
import { invokePublisher, resolveSimulatedPublisher } from "./publisher/registry";
import {
  SimulatedOrgHandle, assertRealPublisherTarget, assertSimulatedWriteAllowed, isSocialSimulationEnabled, realPublisherRefusal,
} from "./publisher/simulation";
import type { OrgHandle, SocialPublisher } from "./publisher/types";

// ── reads (own transaction, own declared scope, no network I/O) ───────────────────────────────────

interface ConnectedAccountRow {
  id: string;
  org_id: string;
  network: string;
  /** NULL only for a SIMULATED account (SCP-Sd): a real one is selected only with an integration id. */
  postiz_integration_id: string | null;
  /** SCP-Sd — `social_accounts.simulated`: its numbers come from the simulator, never from a real engine. */
  simulated: boolean;
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
    `SELECT id, publisher_org_id AS org_id, network, postiz_integration_id, simulated
       FROM social_accounts
      WHERE status = 'connected' AND (postiz_integration_id IS NOT NULL OR simulated) AND deleted_at IS NULL`,
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
  /** SCP-Sd — the variant's ACCOUNT is simulated: its snapshots come from the simulator and are stored `source = 'simulated'`. */
  simulated: boolean;
  /** SCP-Sa2 — the account's integration id, for the reverse fence on the real half. */
  integration_id: string | null;
}

async function loadRecentlyPublished(c: PoolClient, sinceDays: number): Promise<PublishedVariantRow[]> {
  const { rows } = await c.query<PublishedVariantRow>(
    `SELECT v.id AS variant_id, v.provider_post_id, a.publisher_org_id AS org_id, a.simulated,
            a.postiz_integration_id AS integration_id
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
 *  module scope. The rows are the pull's (`source` takes its default, 'pull'; `entered_by` stays NULL), and
 *  `reach` stays NULL too: the engine's `PostMetrics` (publisher/types.ts) has no reach to map, so the
 *  engagement rate of a pulled-only post is null until a person types a reach in (SCP-3c, BFF §63.10). */
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

// ── SCP-Sd: the SIMULATED writers (the only two places a `source = 'simulated'` metric row is written) ──────────────
//
// A simulated account's numbers reach these through the simulator driver (publisher/simulated-driver.ts), resolved by
// `resolveSimulatedPublisher` in the sweep below: the SAME seam as a real engine's numbers, never a side door. They are
// separate from the two real writers above on purpose, so the real SQL stays byte-for-byte what it was and a reader can see
// at a glance which statements may write a simulated row. Each refuses `simulation_disabled` while the switch is off
// (`assertSimulatedWriteAllowed`, the same fence the dispatch stamp uses), declares its own module scope, and is idempotent.

/** How far back the DAILY series of a simulated account is (re)written: a fresh seed gets its history on the first run, and a
 *  missed stretch fills itself. The rewrite of an unchanged day is a no-op (see `applySimulatedDailyMetrics`), so a sweep run
 *  hourly in dev costs one cheap statement per account. */
export const SIMULATED_DAILY_WINDOW_DAYS = 30;

/** (A, simulated) Upsert one simulated account's daily series with `source = 'simulated'`, in ONE statement. Re-running a day
 *  changes nothing: the update is guarded to rows that are still simulated AND would actually change, so a rerun touches no row
 *  (`written` is the number of rows inserted or really changed, 0 on a rerun). A day already held as a real `pull` row is never
 *  overwritten: the guard names `source = 'simulated'`. */
export async function applySimulatedDailyMetrics(
  tenantId: string, accountId: string, series: DailyMetrics[],
): Promise<{ written: number }> {
  assertSimulatedWriteAllowed("metrics-job applySimulatedDailyMetrics");
  if (series.length === 0) return { written: 0 };
  let written = 0;
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const r = await c.query(
      `INSERT INTO social_metrics_daily
         (tenant_id, account_id, date, followers, impressions, reach, engagements, link_clicks, video_views, raw, source)
       SELECT $1::uuid, $2::uuid, d.date, d.followers, d.impressions, d.reach, d.engagements, d.link_clicks, d.video_views,
              '{"simulated": true}'::jsonb, 'simulated'
         FROM unnest($3::date[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::int[])
              AS d(date, followers, impressions, reach, engagements, link_clicks, video_views)
       ON CONFLICT (account_id, date) DO UPDATE SET
         followers = EXCLUDED.followers, impressions = EXCLUDED.impressions, reach = EXCLUDED.reach,
         engagements = EXCLUDED.engagements, link_clicks = EXCLUDED.link_clicks, video_views = EXCLUDED.video_views,
         updated_at = now()
       WHERE social_metrics_daily.source = 'simulated'
         AND (social_metrics_daily.followers, social_metrics_daily.impressions, social_metrics_daily.reach,
              social_metrics_daily.engagements, social_metrics_daily.link_clicks, social_metrics_daily.video_views)
             IS DISTINCT FROM
             (EXCLUDED.followers, EXCLUDED.impressions, EXCLUDED.reach, EXCLUDED.engagements, EXCLUDED.link_clicks, EXCLUDED.video_views)`,
      [
        tenantId, accountId,
        series.map((d) => d.date),
        series.map((d) => d.followers ?? null), series.map((d) => d.impressions ?? null), series.map((d) => d.reach ?? null),
        series.map((d) => d.engagements ?? null), series.map((d) => d.linkClicks ?? null), series.map((d) => d.videoViews ?? null),
      ],
    );
    written = r.rowCount ?? 0;
  });
  return { written };
}

/** (B, simulated) Append the simulated post snapshots that are not yet stored. A snapshot is identified by (variant, the
 *  `capturedAt` the simulator stamped it with, `source = 'simulated'`), and `capturedAt` is a pure function of the post's go-live
 *  moment, so a rerun finds the rows it wrote and appends nothing: exactly one snapshot per variant per day (1, 3, 7), never two.
 *  The table has no unique key to lean on (0105 designs it as free-form append-only history, and a constraint here would be
 *  new DDL), so the check and the insert run in ONE transaction under a per-tenant advisory lock: two overlapping sweeps (the
 *  loop and a manual run) serialise instead of both seeing "absent". An entry with no usable `capturedAt` is skipped (a simulated
 *  snapshot with no moment cannot be told from its twin). `fetched_at` is the stamp, so SCP-3c's "newest snapshot by fetched_at"
 *  read answers day 7 once it exists, then day 3, then day 1. */
export async function appendSimulatedPostMetrics(
  tenantId: string, rows: Array<{ variantId: string; metrics: PostMetrics }>,
): Promise<{ written: number }> {
  assertSimulatedWriteAllowed("metrics-job appendSimulatedPostMetrics");
  const stamped = rows
    .map((r) => ({ ...r, at: r.metrics.capturedAt ? Date.parse(r.metrics.capturedAt) : NaN }))
    .filter((r) => Number.isFinite(r.at));
  if (stamped.length === 0) return { written: 0 };
  let written = 0;
  await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`scp-sd-post-metrics:${tenantId}`]);
    const variantIds = [...new Set(stamped.map((r) => r.variantId))];
    const have = await c.query<{ variant_id: string; fetched_at: Date }>(
      `SELECT variant_id::text AS variant_id, fetched_at FROM social_post_metrics
        WHERE variant_id = ANY($1::uuid[]) AND source = 'simulated'`,
      [variantIds],
    );
    const stored = new Set(have.rows.map((r) => `${r.variant_id}|${new Date(r.fetched_at).getTime()}`));
    for (const { variantId, metrics: m, at } of stamped) {
      const key = `${variantId}|${at}`;
      if (stored.has(key)) continue;
      stored.add(key); // the same snapshot twice in one answer is still one row
      await c.query(
        `INSERT INTO social_post_metrics
           (tenant_id, variant_id, impressions, likes, comments, shares, saves, video_views, clicks, reach, source, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'simulated',$11)`,
        [
          tenantId, variantId,
          m.impressions ?? null, m.likes ?? null, m.comments ?? null, m.shares ?? null,
          m.saves ?? null, m.videoViews ?? null, m.clicks ?? null, m.reach ?? null, new Date(at),
        ],
      );
      written += 1;
    }
  });
  return { written };
}

/** The driver a SIMULATED account's numbers come from, or null while the switch is off. With the switch off nothing simulated
 *  is read, written or logged as an error: the simulated rows are simply left as they are (a real engine is never asked about
 *  them, which is `resolveSimulatedPublisher`'s own refusal made quiet). */
function openSimulatedMetrics(
  tenantId: string, org: PublisherOrgRow, accountId: string | null, capability: "account_metrics" | "post_metrics",
): { driver: SocialPublisher; handle: OrgHandle } | null {
  if (!isSocialSimulationEnabled()) return null;
  return { driver: resolveSimulatedPublisher(capability), handle: new SimulatedOrgHandle(tenantId, accountId, org.id) };
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
  // SCP-Sd — a simulated account's window is wider (its history seeds itself, a missed stretch fills itself) and its rows are
  // the simulator's own writer's, so the two never share a statement.
  const simRange: DateRange = {
    from: new Date(now.getTime() - (SIMULATED_DAILY_WINDOW_DAYS - 1) * 24 * 3600 * 1000).toISOString().slice(0, 10), to,
  };

  for (const acct of accounts) {
    try {
      const org = await loadOrgCached(acct.org_id);
      if (!org) continue;
      if (acct.simulated) {
        const sim = openSimulatedMetrics(tenantId, org, acct.id, "account_metrics");
        if (!sim) continue; // switch off: nothing simulated is pulled or written
        const series = await invokePublisher(
          { op: "getAccountMetrics", org: sim.handle, network: acct.network },
          () => sim.driver.getAccountMetrics(sim.handle, acct.postiz_integration_id ?? acct.id, simRange),
        );
        dailyRows += (await applySimulatedDailyMetrics(tenantId, acct.id, series)).written;
        continue;
      }
      // SCP-Sa2 — the reverse fence (simulation.ts fence 4): a real engine is never asked for a simulated account's numbers.
      // `acct.simulated` is false on this branch by construction; the integration id is the second, independent signal.
      assertRealPublisherTarget(`real account metrics of account ${acct.id}`, {
        simulated: acct.simulated, integrationId: acct.postiz_integration_id,
      });
      const { driver, handle } = openOrg(org);
      if (!driver.capabilities.has("account_metrics")) continue;
      const series = await invokePublisher(
        { op: "getAccountMetrics", org: handle, network: acct.network },
        () => driver.getAccountMetrics(handle, acct.postiz_integration_id as string, range),
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
  // SCP-Sd — grouped by (org, simulated), the post-status sweep's own grouping: a simulated account's variants and a real
  // account's are never sent to the same driver in one call.
  const byOrg = new Map<string, PublishedVariantRow[]>();
  for (const r of published) {
    const key = `${r.org_id}|${r.simulated === true ? "sim" : "real"}`;
    const list = byOrg.get(key) ?? [];
    list.push(r);
    byOrg.set(key, list);
  }

  let postMetricRows = 0;
  for (const [groupKey, rows] of byOrg) {
    const orgId = rows[0].org_id;
    try {
      const org = await loadOrgCached(orgId);
      if (!org) continue;
      if (rows[0].simulated === true) {
        const sim = openSimulatedMetrics(tenantId, org, null, "post_metrics");
        if (!sim) continue; // switch off: nothing simulated is pulled or written
        // ONE call for the org's simulated ids; the answer holds one entry per DUE day (1, 3, 7) per post, each stamped. Several
        // entries share a provider id, so they are grouped, not keyed.
        const snapshots = await invokePublisher(
          { op: "getPostMetrics", org: sim.handle },
          () => sim.driver.getPostMetrics(sim.handle, rows.map((r) => r.provider_post_id)),
        );
        const variantByPostId = new Map(rows.map((r) => [r.provider_post_id, r.variant_id]));
        const simToWrite: Array<{ variantId: string; metrics: PostMetrics }> = [];
        for (const m of snapshots) {
          const variantId = variantByPostId.get(m.providerPostId);
          if (variantId) simToWrite.push({ variantId, metrics: m });
        }
        postMetricRows += (await appendSimulatedPostMetrics(tenantId, simToWrite)).written;
        continue;
      }
      // SCP-Sa2 — the reverse fence on the real half, row by row (the post-status sweep's shape): a row whose account is
      // simulated, whose integration id or provider post id is `simulated:` is refused and logged, never sent to a real engine.
      const realRows: PublishedVariantRow[] = [];
      for (const r of rows) {
        const refusal = realPublisherRefusal(`real post metrics of variant ${r.variant_id}`, {
          simulated: r.simulated, integrationId: r.integration_id, providerPostId: r.provider_post_id,
        });
        if (!refusal) { realRows.push(r); continue; }
        errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[SOCIAL-METRICS-PULL] tenant ${tenantId}: ${refusal.code}: ${refusal.message}`);
      }
      if (realRows.length === 0) continue;
      const { driver, handle } = openOrg(org);
      if (!driver.capabilities.has("post_metrics")) continue;
      const ids = realRows.map((r) => r.provider_post_id);
      const metrics = await invokePublisher(
        { op: "getPostMetrics", org: handle },
        () => driver.getPostMetrics(handle, ids),
      );
      const byPostId = new Map(metrics.map((m) => [m.providerPostId, m]));
      const toWrite: Array<{ variantId: string; metrics: PostMetrics }> = [];
      for (const r of realRows) {
        const m = byPostId.get(r.provider_post_id);
        if (m) toWrite.push({ variantId: r.variant_id, metrics: m });
      }
      const result = await appendPostMetrics(tenantId, toWrite);
      postMetricRows += result.written;
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-METRICS-PULL] org ${groupKey} post-metrics (tenant ${tenantId}) failed:`, (err as Error).message);
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
// The gate lives in `config.social.metricsPull` (enabled / intervalMs), read by `main.ts` — the same
// place every other job in this module is gated from. It was read straight from `process.env` here
// for the length of SMM-24 only because `config.ts` was held by a parallel worktree; that was always
// flagged as a mechanical fold-in, now done. Dark by default, like every other job in this module.

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
