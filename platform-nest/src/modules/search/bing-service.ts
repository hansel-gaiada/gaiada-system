// M5-P5a — the Bing Webmaster connector, the DB side: connect / disconnect a property's Bing API key (sealed in
// the existing connections vault: integration_connections, provider 'bing_webmaster', owner_kind 'client',
// owner_id = the property's client; the key is encrypted by core/secret-box and is never returned, logged or
// put in an error), pull query + page stats into search_bing_performance, and read them back.
//
// MODE. SEARCH_BING_MODE (bing-client.ts): exactly "live" = real Bing calls; anything else = SIMULATE, the
// default. In simulate mode a pull synthesises deterministic rows (stamped simulated = true) and nothing
// leaves the process; connecting accepts any well-formed key and checks nothing with Bing. In live mode a
// connect proves the key (GetUserSites must list this property's site, verified) before it stores anything.
//
// ROWS mirror search_gsc_performance (0061): property x date x kind x key, idempotent on a server-computed
// row_hash with INSERT .. ON CONFLICT DO UPDATE (a re-pull of the same window converges, never duplicates),
// `simulated` stamped on every row. Client-private data: never search_data_cache, never a ledger row.
//
// TENANCY: withTenants([tenantId], .., { modules: ["search"] }) on every call; the controller authorizes
// (resource_search_property read/update) first. A connection belongs to the property's CLIENT, so two
// properties of one client share one Bing key (a Bing API key is per Bing account, not per site); a
// disconnect revokes the vault row only when no other property still points at it.
import { createHash } from "node:crypto";
import { BadGatewayException, HttpException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { config } from "../../config";
import { createConnection, readAccessToken, revokeConnection, setConnectionTokens } from "../../core/integrations.service";
import {
  BING_MAX_ROWS, BingError, bingMode, getPageStats, getQueryStats, getUserSites, type BingStatRow,
} from "./bing-client";
import { siteOriginOf, type FetchImpl } from "./indexnow";

const SEARCH = { modules: ["search"] };
export const BING_PROVIDER = "bing_webmaster";
export const BING_DEFAULT_DAYS = 28;
export const BING_MAX_DAYS = 180;
const KEY_RE = /^[A-Za-z0-9]{16,128}$/;
const UPSERT_CHUNK = 500;

export interface BingDeps { fetchImpl?: FetchImpl; now?: () => Date; env?: NodeJS.ProcessEnv }
const nowOf = (d?: BingDeps): Date => (d?.now ? d.now() : new Date());

let testDeps: BingDeps | null = null;
/** Tests only: the HTTP layer reaches these services without a deps argument. */
export function setBingDepsForTests(d: BingDeps | null): void { testDeps = d; }
const depsOf = (d?: BingDeps): BingDeps => ({ ...(testDeps ?? {}), ...(d ?? {}) });

const refusal = (status: number, message: string, reason: string): HttpException => new HttpException({ message, reason }, status);

interface Prop { id: string; clientId: string; siteUrl: string; bingConnectionId: string | null }
async function loadProp(c: PoolClient, id: string): Promise<Prop | null> {
  const r = await c.query<Prop>(
    `SELECT id, client_id AS "clientId", site_url AS "siteUrl", bing_connection_id AS "bingConnectionId" FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return r.rows[0] ?? null;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

// ── pure: the rows ───────────────────────────────────────────────────────────────────────────────

export const bingRowHash = (propertyId: string, date: string, kind: string, key: string): string =>
  createHash("sha256").update(`${propertyId}|${date}|${kind}|${key}`).digest("hex");

/** Deterministic synthetic stats for SIMULATE mode: the same property and window always give the same rows. */
export function simulateBingRows(propertyId: string, siteUrl: string, from: string, to: string): BingStatRow[] {
  const origin = siteOriginOf(siteUrl) ?? "https://example.com";
  const label = new URL(origin).hostname.replace(/^www\./, "").split(".")[0] || "site";
  const queries = [label, `${label} services`, `${label} contact`];
  const pages = [`${origin}/`, `${origin}/services/`, `${origin}/contact/`];
  const out: BingStatRow[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = start; t <= end; t += 86400_000) {
    const date = day(new Date(t));
    const num = (kind: string, key: string, salt: string, mod: number): number =>
      parseInt(createHash("sha256").update(`${propertyId}|${date}|${kind}|${key}|${salt}`).digest("hex").slice(0, 8), 16) % mod;
    for (const [kind, keys] of [["query", queries], ["page", pages]] as const) {
      for (const key of keys) {
        const clicks = num(kind, key, "c", 12);
        out.push({
          date, kind, key, clicks, impressions: clicks * (5 + num(kind, key, "i", 20)) + num(kind, key, "j", 30),
          avgClickPosition: 1 + num(kind, key, "p", 190) / 10, avgImpressionPosition: 1 + num(kind, key, "q", 290) / 10,
        });
      }
    }
  }
  return out;
}

// ── connect / disconnect / status ────────────────────────────────────────────────────────────────

export async function connectBing(tenantId: string, propertyId: string, apiKey: unknown, userId: string | null, depsIn?: BingDeps): Promise<{ connectionId: string; mode: "live" | "simulate"; verifiedWithBing: boolean }> {
  const deps = depsOf(depsIn);
  if (typeof apiKey !== "string" || !KEY_RE.test(apiKey.trim())) throw new HttpException({ message: "apiKey must be a Bing Webmaster API key (16-128 letters and digits)", reason: "bing_key_malformed" }, 400);
  const key = apiKey.trim();
  const prop = await withTenants([tenantId], (c) => loadProp(c, propertyId), SEARCH);
  if (!prop) throw new NotFoundException("property not found");
  const origin = siteOriginOf(prop.siteUrl);
  if (!origin) throw refusal(409, "the property's site_url is not a plain http(s) origin", "site_url_invalid");
  const mode = bingMode(deps.env);

  let verified = false;
  if (mode === "live") {
    try {
      const sites = await getUserSites(key, { fetchImpl: deps.fetchImpl });
      const mine = sites.find((s) => siteOriginOf(s.url) === origin);
      if (!mine) throw refusal(409, "that Bing account does not list this property's site", "bing_site_not_in_account");
      if (!mine.verified) throw refusal(409, "the site is in that Bing account but not verified there yet", "bing_site_not_verified");
      verified = true;
    } catch (e) {
      if (e instanceof BingError) {
        if (e.kind === "rejected") throw refusal(409, "Bing refused the API key", "bing_key_rejected");
        throw new BadGatewayException({ message: "Bing could not be reached; nothing was stored", reason: "bing_unreachable" });
      }
      throw e;
    }
  }

  // The vault: one row per (company, client, provider). Re-connecting replaces the sealed key.
  const conn = await createConnection(tenantId, { ownerKind: "client", ownerId: prop.clientId, provider: BING_PROVIDER, scopes: [], meta: { mode, siteOrigin: origin }, createdBy: userId });
  await setConnectionTokens(tenantId, conn.id, { accessToken: key });
  await withTenants([tenantId], (c) => c.query(`UPDATE search_properties SET bing_connection_id = $2, updated_at = now() WHERE id = $1`, [propertyId, conn.id]), SEARCH);
  return { connectionId: conn.id, mode, verifiedWithBing: verified };
}

export async function disconnectBing(tenantId: string, propertyId: string): Promise<{ disconnected: boolean; revoked: boolean }> {
  const r = await withTenants([tenantId], async (c) => {
    const prop = await loadProp(c, propertyId);
    if (!prop) throw new NotFoundException("property not found");
    if (!prop.bingConnectionId) return { connectionId: null, shared: false };
    await c.query(`UPDATE search_properties SET bing_connection_id = NULL, updated_at = now() WHERE id = $1`, [propertyId]);
    const others = await c.query(`SELECT 1 FROM search_properties WHERE bing_connection_id = $1 AND deleted_at IS NULL LIMIT 1`, [prop.bingConnectionId]);
    return { connectionId: prop.bingConnectionId, shared: others.rows.length > 0 };
  }, SEARCH);
  if (!r.connectionId) return { disconnected: false, revoked: false };
  if (r.shared) return { disconnected: true, revoked: false };
  await revokeConnection(tenantId, r.connectionId);
  return { disconnected: true, revoked: true };
}

export interface BingStatus {
  propertyId: string; connected: boolean; mode: "live" | "simulate"; lastPulledAt: string | null; rows: { real: number; simulated: number };
}
export async function bingStatus(tenantId: string, propertyId: string, depsIn?: BingDeps): Promise<BingStatus> {
  const deps = depsOf(depsIn);
  return withTenants([tenantId], async (c) => {
    const prop = await loadProp(c, propertyId);
    if (!prop) throw new NotFoundException("property not found");
    const s = await c.query<{ simulated: boolean; n: string; last: Date | null }>(
      `SELECT simulated, count(*) AS n, max(fetched_at) AS last FROM search_bing_performance WHERE property_id = $1 GROUP BY simulated`, [propertyId]);
    const lasts = s.rows.map((r) => r.last).filter((d): d is Date => !!d).map((d) => new Date(d).getTime());
    return {
      propertyId, connected: !!prop.bingConnectionId, mode: bingMode(deps.env),
      lastPulledAt: lasts.length ? new Date(Math.max(...lasts)).toISOString() : null,
      rows: { real: Number(s.rows.find((r) => !r.simulated)?.n ?? 0), simulated: Number(s.rows.find((r) => r.simulated)?.n ?? 0) },
    };
  }, SEARCH);
}

// ── pull ─────────────────────────────────────────────────────────────────────────────────────────

export interface PullResult { propertyId: string; mode: "live" | "simulate"; simulated: boolean; window: { from: string; to: string }; fetched: number; written: number }

async function upsertRows(c: PoolClient, a: { tenantId: string; propertyId: string; connectionId: string; rows: BingStatRow[]; simulated: boolean }): Promise<number> {
  let written = 0;
  for (let i = 0; i < a.rows.length; i += UPSERT_CHUNK) {
    const part = a.rows.slice(i, i + UPSERT_CHUNK);
    const r = await c.query(
      `INSERT INTO search_bing_performance
         (tenant_id, property_id, connection_id, date, kind, key, clicks, impressions, avg_click_position, avg_impression_position, row_hash, simulated, origin_site)
       SELECT $1::uuid, $2::uuid, $3::uuid, u.date, u.kind, u.key, u.clicks, u.impressions, u.acp, u.aip, u.hash, $4::boolean, $5::text
         FROM unnest($6::date[], $7::text[], $8::text[], $9::int[], $10::int[], $11::numeric[], $12::numeric[], $13::text[])
              AS u(date, kind, key, clicks, impressions, acp, aip, hash)
       ON CONFLICT (tenant_id, property_id, row_hash) DO UPDATE
         SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
             avg_click_position = EXCLUDED.avg_click_position, avg_impression_position = EXCLUDED.avg_impression_position,
             connection_id = EXCLUDED.connection_id, simulated = EXCLUDED.simulated, fetched_at = now(), updated_at = now()`,
      [
        a.tenantId, a.propertyId, a.connectionId, a.simulated, config.originSite,
        part.map((x) => x.date), part.map((x) => x.kind), part.map((x) => x.key), part.map((x) => x.clicks), part.map((x) => x.impressions),
        part.map((x) => x.avgClickPosition), part.map((x) => x.avgImpressionPosition),
        part.map((x) => bingRowHash(a.propertyId, x.date, x.kind, x.key)),
      ],
    );
    written += r.rowCount ?? 0;
  }
  return written;
}

export async function pullBing(tenantId: string, propertyId: string, daysIn: unknown, depsIn?: BingDeps): Promise<PullResult> {
  const deps = depsOf(depsIn);
  let days = BING_DEFAULT_DAYS;
  if (daysIn !== undefined && daysIn !== null) {
    if (typeof daysIn !== "number" || !Number.isInteger(daysIn) || daysIn < 1 || daysIn > BING_MAX_DAYS) {
      throw new HttpException({ message: `days must be an integer from 1 to ${BING_MAX_DAYS}`, reason: "bad_days" }, 400);
    }
    days = daysIn;
  }
  const prop = await withTenants([tenantId], (c) => loadProp(c, propertyId), SEARCH);
  if (!prop) throw new NotFoundException("property not found");
  if (!prop.bingConnectionId) throw refusal(409, "connect a Bing Webmaster API key for this property first", "bing_not_connected");
  const origin = siteOriginOf(prop.siteUrl);
  if (!origin) throw refusal(409, "the property's site_url is not a plain http(s) origin", "site_url_invalid");

  const to = day(nowOf(deps));
  const from = day(new Date(nowOf(deps).getTime() - (days - 1) * 86400_000));
  const mode = bingMode(deps.env);
  let rows: BingStatRow[];
  if (mode === "simulate") {
    rows = simulateBingRows(propertyId, prop.siteUrl, from, to);
  } else {
    const key = await withTenants([tenantId], (c) => readAccessToken(c, prop.bingConnectionId!), SEARCH);
    if (!key) throw refusal(409, "the stored Bing key is missing; reconnect", "bing_not_connected");
    try {
      const siteUrl = `${origin}/`;
      const [q, p] = [await getQueryStats(key, siteUrl, { fetchImpl: deps.fetchImpl }), await getPageStats(key, siteUrl, { fetchImpl: deps.fetchImpl })];
      rows = [...q, ...p].filter((r) => r.date >= from && r.date <= to).slice(0, BING_MAX_ROWS);
    } catch (e) {
      if (e instanceof BingError) {
        if (e.kind === "rejected") throw refusal(409, "Bing refused the stored API key; reconnect", "bing_key_rejected");
        throw new BadGatewayException({ message: "Bing could not be reached", reason: e.kind === "bad_response" ? "bing_bad_response" : "bing_unreachable" });
      }
      throw e;
    }
  }
  const written = await withTenants([tenantId], (c) => upsertRows(c, { tenantId, propertyId, connectionId: prop.bingConnectionId!, rows, simulated: mode === "simulate" }), SEARCH);
  return { propertyId, mode, simulated: mode === "simulate", window: { from, to }, fetched: rows.length, written };
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────────

export interface PerformanceQuery { kind?: string; from?: string; to?: string; limit?: number }
export async function listBingPerformance(tenantId: string, propertyId: string, q: PerformanceQuery, depsIn?: BingDeps) {
  const deps = depsOf(depsIn);
  if (q.kind !== undefined && q.kind !== "query" && q.kind !== "page") throw new HttpException({ message: "kind must be query or page", reason: "bad_kind" }, 400);
  const isDay = (s: string | undefined) => s === undefined || /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDay(q.from) || !isDay(q.to)) throw new HttpException({ message: "from and to must be YYYY-MM-DD", reason: "bad_range" }, 400);
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const to = q.to ?? day(nowOf(deps));
  const from = q.from ?? day(new Date(Date.parse(`${to}T00:00:00Z`) - (BING_DEFAULT_DAYS - 1) * 86400_000));
  return withTenants([tenantId], async (c) => {
    if (!(await loadProp(c, propertyId))) throw new NotFoundException("property not found");
    const where = `property_id = $1 AND date BETWEEN $2 AND $3 ${q.kind ? "AND kind = $4" : ""}`;
    const params: unknown[] = [propertyId, from, to, ...(q.kind ? [q.kind] : [])];
    const rows = await c.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, key, clicks, impressions, avg_click_position AS "avgClickPosition", avg_impression_position AS "avgImpressionPosition", simulated
         FROM search_bing_performance WHERE ${where} ORDER BY date DESC, clicks DESC, key LIMIT ${limit}`, params);
    const tot = await c.query<{ clicks: string | null; impressions: string | null }>(
      `SELECT sum(clicks) AS clicks, sum(impressions) AS impressions FROM search_bing_performance WHERE ${where}`, params);
    return {
      propertyId, window: { from, to }, mode: bingMode(deps.env),
      totals: { clicks: Number(tot.rows[0]?.clicks ?? 0), impressions: Number(tot.rows[0]?.impressions ?? 0) },
      rows: rows.rows.map((r) => ({
        ...r,
        avgClickPosition: r.avgClickPosition === null ? null : Number(r.avgClickPosition),
        avgImpressionPosition: r.avgImpressionPosition === null ? null : Number(r.avgImpressionPosition),
      })),
    };
  }, SEARCH);
}

