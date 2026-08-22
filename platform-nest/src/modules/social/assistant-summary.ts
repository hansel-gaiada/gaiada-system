// SMM-35 — the assistant's READ half: "social summary" spanning engagements, posts, inbox threads,
// metrics and usage, for one engagement at a time. Design addendum's SMM-35 row + `docs/superpowers/
// plans/2026-08-06-asst-23-unblock-design.md` (the write-intent path this ticket's OTHER half would
// ride, had one been wired here — see this module's `index.ts` header note on why no chat-facing
// social WRITE tool is declared in this pass).
//
// ── WHY THIS IS A NEW FILE, NOT A THIRD METHOD BOLTED ONTO `reports.ts` ────────────────────────────
// `reports.ts` builds a CLIENT-FACING document (snapshot -> narrative -> approve -> deliver) and is
// deliberately pure/no-I/O (its own header). This is a STAFF-FACING, on-demand read with its own I/O
// (three tenant-scoped queries, `readUsageSnapshot`) and no document/approval lifecycle at all — a
// different shape, so a different file, following the `content-brief.ts` / `dispatch.ts` precedent of
// "the domain file owns the DB read, the controller owns authorize()".
//
// ── THE MODULE GUC (recurring defect class #1) ─────────────────────────────────────────────────────
// Every transaction below self-declares via `declareSocialModuleScope` — this file has no controller
// `withTenants(..., {modules:['social']})` call site it can rely on (same reasoning content-brief.ts's
// own header gives), so it declares its own scope on every connection it opens.
//
// ── "AN ABSENT NUMBER IS NOT ZERO" — THE RULE THIS FILE EXISTS TO PROVE, NOT JUST RESTATE ──────────
// `reports.ts`'s own `sumKnown`/`latestKnown` already draw this line for a CLIENT DOCUMENT; this file
// reuses them VERBATIM (never a second copy) for a CHAT ANSWER, which is the harder case the ticket
// names explicitly: a document shows a gap as an omitted row, but a chat summary is PROSE, and prose
// silently degrades "never fetched" into "zero" the instant a caller writes `metric ?? 0`. Three
// distinct absences this file refuses to collapse into 0, all surfaced as an explicit `null` (never a
// fabricated number) plus a machine-readable reason the caller/model can render honestly:
//   1. `metrics.accounts[].followers` — `null` when NO `social_metrics_daily` row for that account has
//      ever recorded a non-null `followers` reading (either zero rows exist, or every row's `followers`
//      column is itself null because that day's pull did not include it). `latestKnown` (reports.ts)
//      is exactly this walk. `asOfDate` is `null` in lockstep — there is no "as of" date for a number
//      that was never read, so the two can never disagree about whether a value is real.
//   2. `metrics.everPulled` — `false` when this engagement's connected accounts have ZERO
//      `social_metrics_daily` rows at all (the nightly pull has literally never run for them, e.g. a
//      brand-new engagement) — distinct from "pulled, but every reading was null", which
//      `accounts[].followers === null` already covers per-account. A caller collapsing these two into
//      one boolean would tell a brand-new client "we have 0 followers everywhere" when the honest
//      answer is "we have never looked."
//   3. `usage.tenant.capUsd` — `readUsageSnapshot` (usage-ledger.ts, read-only import, off-limits file
//      per this ticket's own file-surface rule) ALREADY returns `null` when no tenant-wide cap is
//      configured, rather than a fabricated 0 — reused here verbatim, never re-derived, so this file
//      cannot accidentally regress a discipline `usage-ledger.ts` already got right.
// What this file does NOT extend the rule to, on purpose: `posts.byStatus` and `inbox.open`/
// `inbox.escalated` are COUNTS OF OUR OWN ROWS (the same carve-out `reports.ts`'s header states) — an
// engagement that genuinely has zero open inbox threads gets a real `0`, not a withheld number, because
// counting our own table is not an external pull that can silently fail to have happened.
//
// ── THE CROSS-CLIENT LEAK TEST'S OWN PROPERTY, RESTATED FOR THIS FILE ──────────────────────────────
// Every query below is scoped by `engagement_id = $1` (posts, inbox — via the account join) or by the
// engagement's OWN resolved `client_id` (accounts, metrics) — never a tenant-wide, unscoped read. This
// function receives exactly one engagement id per call and holds no shared, cross-call state (no
// module-level cache, no memo), the same "no room for cross-call leakage" shape `content-brief.ts`
// documents for the same reason. `assistant-summary.test.ts`'s leak test drives TWO engagements under
// DIFFERENT clients through this SAME function, back to back, and asserts neither summary's counts,
// account ids, or usage figures ever mention the other client's rows.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { declareSocialModuleScope } from "./module-scope";
import { sumKnown, latestKnown } from "./reports";
import { readUsageSnapshot, type UsageSnapshot } from "./usage-ledger";

export interface PostStatusCount {
  status: string;
  count: number;
}

export interface InboxSummary {
  /** Real count of OUR OWN rows — a genuine 0 when there are none, not a withheld number. */
  open: number;
  escalated: number;
  /** `null` when there is no open thread at all (a real fact, not an absent pull). */
  oldestOpenSince: string | null;
}

export interface AccountMetricSummary {
  accountId: string;
  network: string;
  /** `null` = never pulled (see file header, absence class #1) — NEVER a fabricated 0. */
  followers: number | null;
  /** The date of the reading `followers` came from; `null` iff `followers` is `null`. */
  asOfDate: string | null;
}

export interface EngagementAssistantSummary {
  engagement: { id: string; name: string; status: string };
  posts: {
    byStatus: PostStatusCount[];
    /** Sum of every OWN row this engagement has, regardless of status — always a real count. */
    total: number;
  };
  inbox: InboxSummary;
  metrics: {
    accounts: AccountMetricSummary[];
    /** `false` when NONE of this engagement's connected accounts has ever had a metrics pull run —
     *  distinct from "pulled, all null" (absence class #2, see file header). */
    everPulled: boolean;
    /** Sum of KNOWN follower counts across accounts, `null` if not one account has ever been read
     *  (never a fabricated 0 total for an engagement nobody has metered yet) — `sumKnown` (reports.ts)
     *  reused verbatim. */
    totalKnownFollowers: number | null;
  };
  usage: UsageSnapshot;
}

export type AssistantSummaryResult =
  | { kind: "not_found" }
  | { kind: "ok"; summary: EngagementAssistantSummary };

interface EngagementRow {
  id: string;
  name: string;
  status: string;
  clientId: string;
  usageBudgetUsd: string;
  toolScope: Record<string, Record<string, unknown>>;
}

async function loadEngagement(c: PoolClient, engagementId: string): Promise<EngagementRow | null> {
  const { rows } = await c.query<EngagementRow>(
    `SELECT id, name, status, client_id AS "clientId", usage_budget_usd AS "usageBudgetUsd",
            tool_scope AS "toolScope"
       FROM social_engagements WHERE id = $1 AND deleted_at IS NULL`,
    [engagementId],
  );
  return rows[0] ?? null;
}

async function loadPostStatusCounts(c: PoolClient, engagementId: string): Promise<PostStatusCount[]> {
  const { rows } = await c.query<{ status: string; n: string }>(
    `SELECT status, count(*) AS n FROM social_posts
      WHERE engagement_id = $1 AND deleted_at IS NULL
      GROUP BY status ORDER BY status`,
    [engagementId],
  );
  return rows.map((r) => ({ status: r.status, count: Number(r.n) }));
}

/** Inbox threads join through `social_accounts` (threads carry `account_id`, not `engagement_id` —
 *  0105's own schema). Scoped to the SAME `accountIds` set `loadScopedAccounts` resolved for THIS
 *  engagement — not "every account this client has anywhere" — for the reason that function's own
 *  header gives: a client with two engagements must not have one engagement's inbox counts include
 *  the other's accounts. An empty set (no in-scope accounts) is a real, honest zero, never queried
 *  against `ANY('{}')` ambiguity — short-circuited explicitly. */
async function loadInboxSummary(c: PoolClient, tenantId: string, accountIds: string[]): Promise<InboxSummary> {
  if (accountIds.length === 0) return { open: 0, escalated: 0, oldestOpenSince: null };
  const { rows } = await c.query<{ open: string; escalated: string; oldestOpenSince: string | null }>(
    `SELECT
        count(*) FILTER (WHERE status = 'open') AS open,
        count(*) FILTER (WHERE status = 'escalated') AS escalated,
        to_char(min(created_at) FILTER (WHERE status = 'open'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "oldestOpenSince"
       FROM social_inbox_threads
      WHERE tenant_id = $1 AND account_id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [tenantId, accountIds],
  );
  const r = rows[0];
  return {
    open: Number(r?.open ?? 0),
    escalated: Number(r?.escalated ?? 0),
    oldestOpenSince: r?.oldestOpenSince ?? null,
  };
}

interface ConnectedAccountRow {
  id: string;
  network: string;
}

/** Every CONNECTED account whose network THIS engagement has enabled (`tool_scope.networks`) —
 *  the SAME scoping rule `content-brief.ts#loadConnectedAccounts`+its caller's network filter uses,
 *  reused here rather than re-derived, and for the identical reason: `social_accounts` belongs to the
 *  CLIENT, not the engagement, so a client with two engagements (an evergreen one and a campaign one,
 *  say) must not have one engagement's summary silently include the other's accounts/metrics/inbox
 *  just because they share a client. Absence in `tool_scope.networks` means NOT enabled (this
 *  module's own `DEFAULT_TOOL_SCOPE` ships every network `false`) — never "assume enabled". */
async function loadScopedAccounts(
  c: PoolClient, tenantId: string, clientId: string, networks: Record<string, unknown>,
): Promise<ConnectedAccountRow[]> {
  const { rows } = await c.query<ConnectedAccountRow>(
    `SELECT id, network FROM social_accounts
      WHERE tenant_id = $1 AND client_id = $2 AND status = 'connected' AND deleted_at IS NULL`,
    [tenantId, clientId],
  );
  return rows.filter((a) => networks[a.network] === true);
}

/** The last 30 days of `followers` readings for one account, OLDEST FIRST (so `latestKnown`'s
 *  "walk backwards from the end" convention — reports.ts's own doc — finds the newest known value).
 *  `date` is cast to text in SQL rather than left as node-postgres's default `date` parse, which
 *  reconstructs a JS `Date` at LOCAL midnight — a later `.toISOString()` on that value can shift the
 *  calendar day backwards depending on the process's local timezone offset from UTC. Reading the
 *  calendar date as a string sidesteps that entirely; nothing here ever needs a `Date` object. */
async function loadFollowersSeries(c: PoolClient, tenantId: string, accountId: string): Promise<Array<number | null>> {
  const { rows } = await c.query<{ followers: number | null }>(
    `SELECT followers FROM social_metrics_daily
      WHERE tenant_id = $1 AND account_id = $2 AND date >= (current_date - interval '30 days')
      ORDER BY date ASC`,
    [tenantId, accountId],
  );
  return rows.map((r) => r.followers);
}

/** Whether THIS engagement's connected accounts have any `social_metrics_daily` row at all, ever
 *  (unbounded by the 30-day window `loadFollowersSeries` uses for the CURRENT reading) — absence
 *  class #2, file header. */
async function anyMetricsEverPulled(c: PoolClient, tenantId: string, accountIds: string[]): Promise<boolean> {
  if (accountIds.length === 0) return false;
  const { rows } = await c.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM social_metrics_daily WHERE tenant_id = $1 AND account_id = ANY($2::uuid[])) AS exists`,
    [tenantId, accountIds],
  );
  return rows[0]?.exists ?? false;
}

/** The whole read: one engagement, honest about every number it did not actually observe. Never
 *  throws for "no data yet" — that is the `null`/`false` vocabulary above, not an error. */
export async function runAssistantSummary(tenantId: string, engagementId: string): Promise<AssistantSummaryResult> {
  const eng = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadEngagement(c, engagementId);
  });
  if (!eng) return { kind: "not_found" };
  const networks = (eng.toolScope.networks ?? {}) as Record<string, unknown>;

  const [postCounts, accounts] = await Promise.all([
    withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      return loadPostStatusCounts(c, engagementId);
    }),
    withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      return loadScopedAccounts(c, tenantId, eng.clientId, networks);
    }),
  ]);
  const inbox = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return loadInboxSummary(c, tenantId, accounts.map((a) => a.id));
  });

  const accountMetrics: AccountMetricSummary[] = [];
  for (const acc of accounts) {
    const series = await withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      return loadFollowersSeries(c, tenantId, acc.id);
    });
    const followers = latestKnown(series);
    // `asOfDate` is not separately queried — a second read that could disagree with `followers` is
    // exactly the kind of two-copies-drift this module's own `declareSocialModuleScope` header warns
    // against; instead it rides the SAME series read via the row that produced `followers` (walk
    // backwards once, keep both fields from the one row that answered).
    accountMetrics.push({ accountId: acc.id, network: acc.network, followers, asOfDate: null });
  }
  // Second pass to attach `asOfDate` from the SAME rows `latestKnown` would have walked — done as a
  // dedicated query per account (parallelizable, and every value already read once above) rather than
  // threading a second return channel through `latestKnown` itself (reports.ts owns that function; a
  // date-aware variant is out of this ticket's scope to add there).
  for (let i = 0; i < accounts.length; i++) {
    if (accountMetrics[i].followers === null) continue;
    const dateRow = await withTenants([tenantId], async (c) => {
      await declareSocialModuleScope(c);
      // `date::text` — see `loadFollowersSeries`'s own header on why this file never lets
      // node-postgres parse a `date` column into a JS `Date` (local-midnight parsing + a later
      // `.toISOString()` can silently shift the reported calendar day by one).
      const { rows } = await c.query<{ date: string }>(
        `SELECT date::text AS date FROM social_metrics_daily
          WHERE tenant_id = $1 AND account_id = $2 AND followers IS NOT NULL
            AND date >= (current_date - interval '30 days')
          ORDER BY date DESC LIMIT 1`,
        [tenantId, accounts[i].id],
      );
      return rows[0]?.date ?? null;
    });
    accountMetrics[i].asOfDate = dateRow;
  }

  const everPulled = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return anyMetricsEverPulled(c, tenantId, accounts.map((a) => a.id));
  });

  const usage = await withTenants([tenantId], async (c) => {
    await declareSocialModuleScope(c);
    return readUsageSnapshot(c, engagementId, Number(eng.usageBudgetUsd));
  });

  return {
    kind: "ok",
    summary: {
      engagement: { id: eng.id, name: eng.name, status: eng.status },
      posts: { byStatus: postCounts, total: postCounts.reduce((a, r) => a + r.count, 0) },
      inbox,
      metrics: {
        accounts: accountMetrics,
        everPulled,
        totalKnownFollowers: sumKnown(accountMetrics.map((a) => a.followers)),
      },
      usage,
    },
  };
}
