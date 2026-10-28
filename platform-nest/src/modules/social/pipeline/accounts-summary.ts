// SCP-Sg — the client's accounts, read back: followers, reach and "Last synced" (BFF §63.1 file 8, §63.10; plan §5, §8 row Sg).
//
//   GET engagements/:engagementId/accounts-summary    social_post · read     one row per account of the client, and the totals
//
// WHAT IT READS. `social_metrics_daily`, the table the hourly metrics sweep fills (metrics-job.ts): a REAL account's rows come from the network's pull
// (`source = 'pull'`), a SIMULATED account's from the simulator (SCP-Sd, `source = 'simulated'`). Nothing here asks a network, so the page works with no
// Meta app at all, and says so (`simulated`).
//
// PER ACCOUNT (the client's accounts, not deleted, ordered as `GET accounts` orders them: network, then handle):
//   - `followers`         the NEWEST row's followers (a row that reported none is skipped: "not reported" is null, never 0);
//   - `followersDelta30d` that newest followers minus the OLDEST reported followers inside the 30-day window; null when the newest row is outside the
//                         window (a stale sync says nothing about the last 30 days) or is the only one in it (one point is not a change);
//   - `reach30d`, `impressions30d`  the sums over the window; null when no row in it reported the counter (never a 0 nobody measured);
//   - `lastSyncedAt`      the NEWEST row's `updated_at` (the sweep re-writes a day's row, so this moves with every sync); null when the account has no row;
//   - `source`            `simulated` for a simulated account, `pull` for a real one, null with no row.
// THE WINDOW is the last 30 UTC days, today included (`date >= today - 29`), the same day the sweep keys its rows on.
//
// NEVER MIXED. An account is simulated or it is not, and only the rows of its own kind are counted: a simulated account counts `simulated` rows only, a
// real one `pull` rows only. A pulled number can therefore never be reported under a simulated account, nor the reverse, whatever a past run left in the
// table. `simulated` (top level) is true when any account answered a number from simulated rows, so the page marks the totals SIMULATED.
//
// TOTALS: `followers` and `reach30d` add what the accounts reported (null when none did). `lastSyncedAt` (top level, additive) is the newest of the
// accounts' own, the value the Feed preview's "Last synced" shows too (`readClientLastSyncedAt`).
//
// AUTHORIZATION BEFORE VALIDATION (§63.0): `social_post` · `read`, judged before the engagement is looked at, so a refused caller gets 403 whatever the id
// is. An id that is not a uuid, another engagement of no company of the caller, and one that is deleted are all 404 `engagement_not_found`.
//
// THE MODULE WALL. Every query runs inside `withTenants([tenantId], …, { modules: ["social"] })`: `social_engagements`, `social_accounts` and
// `social_metrics_daily` carry 0105's third wall (an unset scope reads ZERO rows, silently).
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { authorize } from "../../../core/http";
import type { Principal } from "../../../rbac/principal";
import { declareSocialModuleScope } from "../module-scope";
import { isUuidText } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";

const SOCIAL = { modules: ["social"] };

/** The days the 30-day numbers cover, today included. */
export const SUMMARY_WINDOW_DAYS = 30;

export type AccountSummarySource = "pull" | "simulated";

export interface AccountSummary {
  accountId: string;
  network: string;
  handle: string;
  simulated: boolean;
  followers: number | null;
  followersDelta30d: number | null;
  reach30d: number | null;
  impressions30d: number | null;
  lastSyncedAt: string | null;
  source: AccountSummarySource | null;
}

export interface AccountsSummaryAnswer {
  accounts: AccountSummary[];
  totals: { followers: number | null; reach30d: number | null };
  /** True when any account's numbers are the simulator's: the page marks the totals SIMULATED. */
  simulated: boolean;
  /** The newest `lastSyncedAt` of the accounts; null when none has synced. */
  lastSyncedAt: string | null;
}

interface SummaryRow {
  account_id: string; network: string; handle: string; simulated: boolean;
  followers: number | null; followers_date: string | null;
  base_followers: number | null; base_date: string | null;
  reach_30d: string | null; impressions_30d: string | null;
  last_synced_at: Date | string | null;
}

/** PURE. `Number` of a bigint column read as text, or null for SQL NULL. */
const count = (v: string | number | null): number | null => (v === null ? null : Number(v));
/** The `date` columns are read `::text` (`YYYY-MM-DD`): pg would parse a bare `date` at the server's LOCAL midnight, and a day is not an instant. */
const dayOf = (v: string): string => v.slice(0, 10);

/** PURE. The newest of some timestamps (an ISO string each), or null. */
export function newestOf(values: ReadonlyArray<string | null>): string | null {
  let best: string | null = null;
  for (const v of values) if (v !== null && (best === null || Date.parse(v) > Date.parse(best))) best = v;
  return best;
}

/** PURE. The 30-day change of followers: null unless the newest followers row is inside the window and the window holds an older one. */
export function followersDelta(
  latest: { followers: number; day: string } | null, base: { followers: number; day: string } | null, windowStartDay: string,
): number | null {
  if (!latest || !base) return null;
  if (latest.day < windowStartDay) return null; // a stale sync says nothing about the last 30 days
  if (base.day >= latest.day) return null; // the newest row is the only point in the window
  return latest.followers - base.followers;
}

/** PURE. The answer from the per-account rows: the shape, the totals and the marks (everything the SQL left to JS). */
export function buildSummary(rows: readonly SummaryRow[], today: string): AccountsSummaryAnswer {
  const windowStart = new Date(Date.parse(`${today}T00:00:00Z`) - (SUMMARY_WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const accounts = rows.map((r): AccountSummary => {
    const lastSyncedAt = r.last_synced_at === null ? null : new Date(r.last_synced_at).toISOString();
    return {
      accountId: r.account_id, network: r.network, handle: r.handle, simulated: r.simulated === true,
      followers: r.followers,
      followersDelta30d: followersDelta(
        r.followers !== null && r.followers_date !== null ? { followers: r.followers, day: dayOf(r.followers_date) } : null,
        r.base_followers !== null && r.base_date !== null ? { followers: r.base_followers, day: dayOf(r.base_date) } : null,
        windowStart,
      ),
      reach30d: count(r.reach_30d),
      impressions30d: count(r.impressions_30d),
      lastSyncedAt,
      source: lastSyncedAt === null ? null : r.simulated === true ? "simulated" : "pull",
    };
  });
  const sum = (pick: (a: AccountSummary) => number | null): number | null => {
    let total: number | null = null;
    for (const a of accounts) { const v = pick(a); if (v !== null) total = (total ?? 0) + v; }
    return total;
  };
  return {
    accounts,
    totals: { followers: sum((a) => a.followers), reach30d: sum((a) => a.reach30d) },
    simulated: accounts.some((a) => a.source === "simulated"),
    lastSyncedAt: newestOf(accounts.map((a) => a.lastSyncedAt)),
  };
}

/**
 * The SQL fragment both reads share: the daily rows that COUNT for an account, as `m` (`account_id`, `date`, `followers`, `impressions`, `reach`,
 * `updated_at`). A simulated account counts `simulated` rows only, a real one `pull` rows only (the header says why). `$1` is the tenant, `$2` the client.
 */
const COUNTED_ROWS = `
  acc AS (
    SELECT a.id, a.network, a.handle, a.simulated
      FROM social_accounts a
     WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.deleted_at IS NULL
  ),
  m AS (
    SELECT a.id AS account_id, d.date, d.followers, d.impressions, d.reach, d.updated_at
      FROM acc a
      JOIN social_metrics_daily d ON d.tenant_id = $1 AND d.account_id = a.id
       AND d.source = CASE WHEN a.simulated THEN 'simulated' ELSE 'pull' END
  )`;

/** The engagement's client, or null for an engagement that does not exist, is deleted or is another company's (the walls hide it). */
async function loadClientId(c: PoolClient, tenantId: string, engagementId: string): Promise<string | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ client_id: string }>(
    `SELECT client_id::text AS client_id FROM social_engagements WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [tenantId, engagementId],
  );
  return rows[0]?.client_id ?? null;
}

/** The per-account rows of one client, on a caller-owned client (the social module scope declared). */
async function readSummaryRows(c: PoolClient, tenantId: string, clientId: string): Promise<{ rows: SummaryRow[]; today: string }> {
  const { rows } = await c.query<SummaryRow & { today: string }>(
    `WITH ${COUNTED_ROWS},
     t AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d)
     SELECT a.id::text AS account_id, a.network, a.handle, a.simulated,
            lf.followers, lf.date::text AS followers_date,
            bf.followers AS base_followers, bf.date::text AS base_date,
            w.reach_30d::text AS reach_30d, w.impressions_30d::text AS impressions_30d,
            s.last_synced_at, t.d::text AS today
       FROM acc a CROSS JOIN t
       LEFT JOIN LATERAL (
         SELECT x.followers, x.date FROM m x WHERE x.account_id = a.id AND x.followers IS NOT NULL ORDER BY x.date DESC LIMIT 1
       ) lf ON true
       LEFT JOIN LATERAL (
         SELECT x.followers, x.date FROM m x
          WHERE x.account_id = a.id AND x.followers IS NOT NULL AND x.date >= t.d - ${SUMMARY_WINDOW_DAYS - 1} ORDER BY x.date ASC LIMIT 1
       ) bf ON true
       LEFT JOIN LATERAL (
         SELECT sum(x.reach) AS reach_30d, sum(x.impressions) AS impressions_30d FROM m x WHERE x.account_id = a.id AND x.date >= t.d - ${SUMMARY_WINDOW_DAYS - 1}
       ) w ON true
       LEFT JOIN LATERAL (SELECT max(x.updated_at) AS last_synced_at FROM m x WHERE x.account_id = a.id) s ON true
      ORDER BY a.network, a.handle, a.id`,
    [tenantId, clientId],
  );
  // `today` rides on every row; with no account there is no row, and the clock's own UTC day stands in (no row is built from it then).
  const today = rows[0] ? dayOf(rows[0].today) : new Date().toISOString().slice(0, 10);
  return { rows, today };
}

/**
 * The newest `updated_at` among the client's counted metrics rows, as an ISO string, or null when none has synced. The Feed preview's "Last synced" is this
 * value, and equals the summary's top-level `lastSyncedAt` because both read the same counted rows.
 */
export async function readClientLastSyncedAt(c: PoolClient, tenantId: string, clientId: string): Promise<string | null> {
  const { rows } = await c.query<{ last_synced_at: Date | string | null }>(
    `WITH ${COUNTED_ROWS} SELECT max(m.updated_at) AS last_synced_at FROM m`, [tenantId, clientId],
  );
  const v = rows[0]?.last_synced_at ?? null;
  return v === null ? null : new Date(v).toISOString();
}

/** `GET engagements/:engagementId/accounts-summary`: see the header. */
export async function readAccountsSummary(principal: Principal, tenantId: string, engagementId: string): Promise<AccountsSummaryAnswer> {
  await authorize(principal, { kind: "social_post", tenantId, module: "social" }, "read");
  if (!isUuidText(engagementId)) throw new ScpRouteError(404, "engagement_not_found");
  const read = await withTenants([tenantId], async (c) => {
    const clientId = await loadClientId(c, tenantId, engagementId);
    return clientId ? readSummaryRows(c, tenantId, clientId) : null;
  }, SOCIAL);
  if (!read) throw new ScpRouteError(404, "engagement_not_found");
  return buildSummary(read.rows, read.today);
}
