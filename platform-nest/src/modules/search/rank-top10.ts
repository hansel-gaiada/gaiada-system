// The ONE "keywords currently in the top 10" read (PV6-02). Before this file the same DISTINCT ON shape
// was typed three times (the rollup in index.ts, the report-narrative facts in search.controller.ts, and
// the disclosure grouping in search-reports.controller.ts), and PV6-02's client-facing results needed it
// a fourth time. One definition now; callers pass the provenance they want.
//
// "Currently" = the latest snapshot per (keyword, engine, device). `position` is NULL when the keyword was
// not found in the SERP, so a NULL is never inside 1..10 and never counted.
//
// PROVENANCE IS THE CALLER'S DECISION, and it is required (no default) so no call site can forget it:
//   - internal rollups / drafts filter on the CURRENT provider mode (`config.search.providerMode === "simulate"`),
//     the SM-46a/b rule: a demo instance reports its own simulated history, a live one never blends it in.
//   - the CLIENT-facing read passes `simulated: false` always: a client must never see a simulated figure.
//
// `tracked` is how many (keyword, engine, device) series had a snapshot at all. It exists so a caller can say
// "no ranking data yet" (tracked = 0, an unknown) instead of "0 keywords in the top 10" (a claim).
//
// Runs under the caller's own connection and module scope: the caller owns `withTenants(..., {modules:['search']})`.
import type { PoolClient } from "pg";

export interface RankTop10Options {
  /** One property, or null for every property visible to the connection (the exec rollup). */
  propertyId: string | null;
  /** Which provenance to count: true = simulated snapshots only, false = real snapshots only. */
  simulated: boolean;
  /** Only snapshots captured STRICTLY BEFORE this instant: the top 10 as it stood then. Omitted = now. */
  asOf?: Date;
}

export interface RankTop10Result {
  top10: number;
  tracked: number;
  /** Capture time of the newest snapshot counted, as ISO-8601; null when none. */
  latestCapturedAt: string | null;
}

export async function rankTop10(c: PoolClient, opts: RankTop10Options): Promise<RankTop10Result> {
  const r = await c.query<{ top10: string; tracked: string; latest: Date | null }>(
    `SELECT count(*) FILTER (WHERE latest.position BETWEEN 1 AND 10) AS top10,
            count(*) AS tracked,
            max(latest.captured_at) AS latest
       FROM (
         SELECT DISTINCT ON (keyword_id, engine, device) position, captured_at
           FROM search_rank_snapshots
          WHERE ($1::uuid IS NULL OR property_id = $1::uuid)
            AND simulated = $2
            AND ($3::timestamptz IS NULL OR captured_at < $3::timestamptz)
          ORDER BY keyword_id, engine, device, captured_at DESC
       ) latest`,
    [opts.propertyId, opts.simulated, opts.asOf ? opts.asOf.toISOString() : null],
  );
  const row = r.rows[0];
  return {
    top10: Number(row?.top10 ?? 0),
    tracked: Number(row?.tracked ?? 0),
    latestCapturedAt: row?.latest ? new Date(row.latest).toISOString() : null,
  };
}
