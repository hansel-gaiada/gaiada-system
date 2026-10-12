// M5-P5b — the AI-crawler log's database side: an idempotent ingest of a log chunk and the reads behind the SM-16
// panels. Pure aggregation lives in ai-crawler-log.ts; this file only stores its output. All access goes through
// withTenants([tenantId], {modules:['search']}) so RLS (FORCE, search scope) is the wall.
//
// What is stored: day, bot id, path (no query), status, verification, hits. Never a raw line, IP or User-Agent.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { aggregateAiCrawlerLog, type AggregateStats, type CrawlerVerifier } from "./ai-crawler-log";

export const MAX_CHUNK_CHARS = 900_000; // under Fastify's 1 MB default body limit

export interface IngestOutcome {
  /** "duplicate": this exact chunk was ingested before for this property; nothing was changed. */
  chunk: "new" | "duplicate";
  stats: AggregateStats | null;
  rows: number;
  verification: "claimed" | "ranges";
}

/** Hash of the chunk's lines after trimming line endings, so CRLF vs LF and a trailing newline do not defeat the
 *  duplicate check. Not reversible to the lines. */
export function chunkHash(chunk: string): string {
  const norm = chunk.split(/\r?\n/).filter((l) => l.trim()).join("\n");
  return createHash("sha256").update(norm).digest("hex");
}

export async function ingestAiCrawlerChunk(p: {
  tenantId: string; propertyId: string; chunk: string; userId: string | null;
  verifier?: CrawlerVerifier; now?: Date;
}): Promise<IngestOutcome | "no_property"> {
  const verification = p.verifier ? ("ranges" as const) : ("claimed" as const);
  // Parse and verify BEFORE opening the transaction: the verifier is the only place an IP is used.
  const agg = await aggregateAiCrawlerLog(p.chunk, { verifier: p.verifier, now: p.now });
  const hash = chunkHash(p.chunk);
  return withTenants([p.tenantId], async (c: PoolClient) => {
    const prop = await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [p.propertyId]);
    if (!prop.rows[0]) return "no_property" as const;
    const ins = await c.query(
      `INSERT INTO search_ai_crawler_chunks (tenant_id, property_id, chunk_hash, rows_kept, ingested_by)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING chunk_hash`,
      [p.tenantId, p.propertyId, hash, agg.rows.length, p.userId],
    );
    if (!ins.rows[0]) return { chunk: "duplicate" as const, stats: null, rows: 0, verification };
    for (let i = 0; i < agg.rows.length; i += 1000) {
      const b = agg.rows.slice(i, i + 1000);
      await c.query(
        `INSERT INTO search_ai_crawler_daily (tenant_id, property_id, day, bot, path, status, verification, hits)
         SELECT $1::uuid, $2::uuid, d, b, pth, s, v, h
           FROM unnest($3::date[], $4::text[], $5::text[], $6::smallint[], $7::text[], $8::int[]) AS t(d, b, pth, s, v, h)
         ON CONFLICT (tenant_id, property_id, day, bot, path, status, verification)
         DO UPDATE SET hits = search_ai_crawler_daily.hits + EXCLUDED.hits, updated_at = now()`,
        [
          p.tenantId, p.propertyId, b.map((r) => r.day), b.map((r) => r.bot), b.map((r) => r.path),
          b.map((r) => r.status), b.map((r) => r.verification), b.map((r) => r.hits),
        ],
      );
    }
    return { chunk: "new" as const, stats: agg.stats, rows: agg.rows.length, verification };
  }, { modules: ["search"] });
}

export interface CrawlerSummary {
  /** "no_data": nothing was ever ingested for this property. "no_data_in_range": data exists, none in this range. */
  state: "ok" | "no_data" | "no_data_in_range";
  message?: string;
  range: { from: string; to: string };
  coverage: { firstDay: string | null; lastDay: string | null };
  totalHits?: number;
  byDay?: Array<{ day: string; bot: string; hits: number }>;
  byBot?: Array<{ bot: string; hits: number; verified: number; unverified: number; claimed: number }>;
  topPaths?: Array<{ path: string; hits: number }>;
  statusMix?: Array<{ status: number; hits: number }>;
}

const d = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function readCrawlerSummary(
  tenantId: string, propertyId: string, range: { from: string; to: string },
): Promise<CrawlerSummary | "no_property"> {
  return withTenants([tenantId], async (c: PoolClient) => {
    const prop = await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]);
    if (!prop.rows[0]) return "no_property" as const;
    const cov = await c.query<{ first: unknown; last: unknown }>(
      `SELECT min(day) AS first, max(day) AS last FROM search_ai_crawler_daily WHERE property_id = $1`, [propertyId],
    );
    const first = cov.rows[0]?.first ? d(cov.rows[0].first) : null;
    const last = cov.rows[0]?.last ? d(cov.rows[0].last) : null;
    const base = { range, coverage: { firstDay: first, lastDay: last } };
    if (!first) {
      return { state: "no_data" as const, ...base, message: "No AI-crawler log has been ingested for this property yet, so there is nothing to show. Ship the site's access log (see the AI-crawler log runbook)." };
    }
    const w = [propertyId, range.from, range.to];
    const where = `property_id = $1 AND day BETWEEN $2 AND $3`;
    const [byDay, byBot, paths, status] = await Promise.all([
      c.query(`SELECT day, bot, sum(hits)::int AS hits FROM search_ai_crawler_daily WHERE ${where} GROUP BY day, bot ORDER BY day, bot`, w),
      c.query(
        `SELECT bot, sum(hits)::int AS hits,
                coalesce(sum(hits) FILTER (WHERE verification = 'verified'), 0)::int AS verified,
                coalesce(sum(hits) FILTER (WHERE verification = 'unverified'), 0)::int AS unverified,
                coalesce(sum(hits) FILTER (WHERE verification = 'claimed'), 0)::int AS claimed
           FROM search_ai_crawler_daily WHERE ${where} GROUP BY bot ORDER BY sum(hits) DESC, bot`, w),
      c.query(`SELECT path, sum(hits)::int AS hits FROM search_ai_crawler_daily WHERE ${where} GROUP BY path ORDER BY sum(hits) DESC, path LIMIT 20`, w),
      c.query(`SELECT status, sum(hits)::int AS hits FROM search_ai_crawler_daily WHERE ${where} GROUP BY status ORDER BY status`, w),
    ]);
    if (byDay.rows.length === 0) {
      return { state: "no_data_in_range" as const, ...base, message: `No AI-crawler requests were recorded between ${range.from} and ${range.to}. The log has data from ${first} to ${last}.` };
    }
    return {
      state: "ok" as const, ...base,
      totalHits: byBot.rows.reduce((n, r) => n + Number(r.hits), 0),
      byDay: byDay.rows.map((r) => ({ day: d(r.day), bot: String(r.bot), hits: Number(r.hits) })),
      byBot: byBot.rows.map((r) => ({ bot: String(r.bot), hits: Number(r.hits), verified: Number(r.verified), unverified: Number(r.unverified), claimed: Number(r.claimed) })),
      topPaths: paths.rows.map((r) => ({ path: String(r.path), hits: Number(r.hits) })),
      statusMix: status.rows.map((r) => ({ status: Number(r.status), hits: Number(r.hits) })),
    };
  }, { modules: ["search"] });
}

export interface VisibilitySummary {
  state: "ok" | "no_data";
  message?: string;
  lastCapturedAt?: string;
  /** Any row came from the simulated provider mode: the UI badges it, never hides it (SM-16 law). */
  anySimulated?: boolean;
  engines?: Array<{ engine: string; queries: number; mentioned: number; cited: number; changed: number }>;
  latest?: Array<{
    engine: string; query: string; brandMentioned: boolean; cited: boolean; citedUrl: string | null;
    prominence: number | null; capturedAt: string; simulated: boolean; changed: boolean;
  }>;
}

/** What ai-visibility.ts already records (search_ai_visibility): the newest row per (engine, query), with whether
 *  it changed against the row before it. Same table the GEO console reads; this is the property-scoped summary. */
export async function readVisibilitySummary(tenantId: string, propertyId: string): Promise<VisibilitySummary | "no_property"> {
  return withTenants([tenantId], async (c: PoolClient) => {
    const prop = await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]);
    if (!prop.rows[0]) return "no_property" as const;
    const r = await c.query(
      `WITH r AS (
         SELECT engine, query, brand_mentioned, cited, cited_url, prominence, captured_at, simulated,
                lag(brand_mentioned) OVER w AS prev_m, lag(cited) OVER w AS prev_c,
                row_number() OVER (PARTITION BY engine, query ORDER BY captured_at DESC) AS rn
           FROM search_ai_visibility WHERE property_id = $1
         WINDOW w AS (PARTITION BY engine, query ORDER BY captured_at))
       SELECT engine, query, brand_mentioned, cited, cited_url, prominence, captured_at, simulated,
              (prev_m IS NOT NULL AND (prev_m <> brand_mentioned OR prev_c <> cited)) AS changed
         FROM r WHERE rn = 1 ORDER BY engine, query LIMIT 500`,
      [propertyId],
    );
    if (r.rows.length === 0) {
      return { state: "no_data" as const, message: "No AI-visibility check has run for this property yet, so there is nothing to show." };
    }
    const latest = r.rows.map((x) => ({
      engine: String(x.engine), query: String(x.query), brandMentioned: !!x.brand_mentioned, cited: !!x.cited,
      citedUrl: (x.cited_url as string | null) ?? null, prominence: x.prominence === null ? null : Number(x.prominence),
      capturedAt: new Date(x.captured_at).toISOString(), simulated: !!x.simulated, changed: !!x.changed,
    }));
    const by = new Map<string, { engine: string; queries: number; mentioned: number; cited: number; changed: number }>();
    for (const l of latest) {
      const e = by.get(l.engine) ?? { engine: l.engine, queries: 0, mentioned: 0, cited: 0, changed: 0 };
      e.queries++; if (l.brandMentioned) e.mentioned++; if (l.cited) e.cited++; if (l.changed) e.changed++;
      by.set(l.engine, e);
    }
    return {
      state: "ok" as const,
      lastCapturedAt: latest.reduce((m, l) => (l.capturedAt > m ? l.capturedAt : m), latest[0].capturedAt),
      anySimulated: latest.some((l) => l.simulated),
      engines: [...by.values()], latest,
    };
  }, { modules: ["search"] });
}
