// SM-04 — the shared market-data cache layer over `search_data_cache` (design §05, no-RLS D-4) plus
// the single-flight critical-section runner that makes dispatch stampede-proof and money-safe.
//
// ── The no-RLS invariant (QA-flagged) ──────────────────────────────────────────────────────────────
// `search_data_cache` carries NO tenant_id and NO RLS (0034, D-4): the cross-tenant reuse of public
// market data IS the cost model. The service-layer invariant "only the provider layer touches it,
// and it never stores client identifiers" is NOT DB-enforced in v1 — it is enforced HERE, by keeping
// every read/write of that table inside this file (and the cache key builder below, which composes
// keys only from public market coordinates: kind, provider class, normalized query, engine, locale,
// location — never a tenant_id, client_id, engagement_id, or property_id). See the reviewer notes.
//
// ── SM-33: cross-mode cache reads are forbidden, SYMMETRICALLY (addendum §A4.2, ruled) ────────────
// Because this table is cross-tenant and long-lived, a synthetic payload left behind by a dev/demo
// session would otherwise be served to every tenant asking for the same market coordinate after the
// platform flipped to `live`. The mechanism is the `simulated` column (0047) plus an EQUALITY
// PREDICATE in readFreshCache (`AND simulated = <mode>`) — not a cache-key change. Both directions
// are refused: a live read must never serve a simulated row (an unlabelled plausible number in front
// of a client), and a simulate read must never serve a live row (it would misrepresent what
// simulation mode is and poison determinism). The primary key stays `cache_key` ALONE, so after a
// mode flip a write for the same key OVERWRITES the other mode's row with payload and flag updated
// atomically — provenance can therefore never disagree with the payload it sits on. The accepted
// cost is cache churn after a mode flip (one re-pull per key), which is a rare, deliberate
// environment event.
//
// ── The critical section ─────────────────────────────────────────────────────────────────────────
// runInCacheCriticalSection() opens ONE transaction on a raw pooled connection, sets BOTH tenant
// GUCs (so ledger writes on the SAME connection satisfy the third-wall RLS), then takes two
// xact-scoped advisory locks in a FIXED order (engagement, then cache-key) — released automatically
// on COMMIT/ROLLBACK, so no lock can leak even on crash. Engagement-first ordering serializes spend
// decisions per engagement; cache-key serialization guarantees a cache miss dispatches exactly once
// even across tenants sharing the same market coordinate.
import type { PoolClient } from "pg";
import { getPool } from "../../../db";
import { type CacheKind, type OpKind, type ProviderOp, CACHE_TTL_SECONDS } from "./types";

// Advisory-lock namespaces (int4, < 2^31). Distinct namespaces so an engagementId hash can never
// collide with a cache-key hash in the same lock space.
const SEARCH_ENG_LOCK_NS = 0x53450001; // 'SE' engagement-spend serialization
const SEARCH_CACHE_LOCK_NS = 0x53430001; // 'SC' cache-key single-flight

/** Canonical cache key (design §05): `kind|provider-class|norm(query)|engine|locale|location`.
 *  Deliberately excludes every tenant/client coordinate — the whole point is cross-tenant reuse.
 *
 *  SM-33 note: the key is deliberately UNCHANGED by simulation mode (addendum §A4.2). Mode is a row
 *  PREDICATE, not a key component — see the header block and readFreshCache below. Keying on mode was
 *  the rejected alternative: it would leave two rows per market coordinate forever and make
 *  "which payload is authoritative for this key" a question with two answers. */
export function buildCacheKey(providerClass: string, op: ProviderOp): string {
  const norm = op.query.trim().toLowerCase().replace(/\s+/g, " ");
  return [
    op.kind,
    providerClass,
    norm,
    op.engine ?? "_",
    op.locale ?? "_",
    op.locationCode ?? "_",
  ].join("|");
}

export interface CacheEntry {
  payload: unknown;
  provider: string;
  costUsd: number;
  fetchedAt: Date;
  expiresAt: Date;
  /** SM-33 provenance (0047): was this payload synthesized by a simulation driver? Returned so the
   *  caller stamps the SERVED row's provenance on its ledger row, rather than re-deriving it from
   *  the current platform mode — the badge must describe the bytes, not the config. */
  simulated: boolean;
}

/** Read a FRESH (unexpired) cache row on the given connection, or null. Any connection works —
 *  the table is no-RLS — but callers pass the critical-section connection to read-under-lock.
 *
 *  SM-33 `simulated` is the MODE PREDICATE and is REQUIRED, not optional (addendum §A4.2): a row
 *  written in the other mode is invisible here — it is not "found and then rejected", the SQL simply
 *  does not match it, so the caller takes its normal miss path and re-pulls. Required rather than
 *  defaulted because "forgot to pass the mode" would silently reintroduce exactly the cross-mode read
 *  this predicate exists to forbid — the same failure shape as the §4d try/catch that degraded the
 *  global ceiling to $0. There is one caller (dispatch.ts); making it explicit costs nothing. */
export async function readFreshCache(
  c: PoolClient,
  cacheKey: string,
  simulated: boolean,
): Promise<CacheEntry | null> {
  const r = await c.query<{ payload: unknown; provider: string; cost_usd: string; fetched_at: Date; expires_at: Date; simulated: boolean }>(
    `SELECT payload, provider, cost_usd, fetched_at, expires_at, simulated
       FROM search_data_cache
      WHERE cache_key = $1 AND expires_at > now() AND simulated = $2`,
    [cacheKey, simulated],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    payload: row.payload,
    provider: row.provider,
    costUsd: Number(row.cost_usd),
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    simulated: row.simulated,
  };
}

/** Upsert a cache row with the per-kind TTL (design §05). Overwrites a stale entry for the same key.
 *
 *  SM-33 (addendum §A4.2): the row's provenance is stamped here, and the conflict update moves
 *  `payload` and `simulated` TOGETHER in one statement — so a row can never be found carrying a
 *  payload from one mode and a flag from the other. Overwriting ACROSS modes is the intended
 *  behaviour, not a hazard to guard: the PK is `cache_key` alone, so after a deliberate mode flip the
 *  first pull for a key replaces the other mode's row wholesale, and the read predicate meanwhile
 *  guarantees nothing stale was served in the interim. Accepted cost: one re-pull per key after a
 *  flip (documented in the header).
 *
 *  SM-44(a): `simulated` is REQUIRED, not defaulted — mirrors readFreshCache's own required
 *  parameter above. A defaulted `false` here was the same "forgot to pass the mode" hazard as the
 *  §4d try/catch that degraded the global ceiling to $0, except UNDER-labelling instead of
 *  over-labelling: a caller that forgot the mode would silently write a REAL-looking row for
 *  synthetic data, which is the more expensive direction (a client could read invented numbers with
 *  no badge on them). "Forgot to pass the mode" is now a compile error instead of a silent wrong
 *  answer, exactly as the ticket's rationale states. dispatch.ts is the sole caller and already
 *  passes `simulated` explicitly, so this is a signature tightening with zero behaviour change at
 *  the one real call site. */
export async function writeCache(
  c: PoolClient,
  cacheKey: string,
  kind: OpKind,
  payload: unknown,
  provider: string,
  costUsd: number,
  simulated: boolean,
): Promise<void> {
  const ttl = CACHE_TTL_SECONDS[kind];
  await c.query(
    `INSERT INTO search_data_cache (cache_key, kind, payload, provider, cost_usd, fetched_at, expires_at, simulated)
     VALUES ($1, $2::text, $3, $4, $5, now(), now() + ($6 || ' seconds')::interval, $7)
     ON CONFLICT (cache_key) DO UPDATE SET
       payload = EXCLUDED.payload, provider = EXCLUDED.provider, cost_usd = EXCLUDED.cost_usd,
       fetched_at = now(), expires_at = EXCLUDED.expires_at, simulated = EXCLUDED.simulated`,
    [cacheKey, kind as CacheKind, JSON.stringify(payload), provider, costUsd, String(ttl), simulated],
  );
}

/** Run `fn` inside the money-safe critical section: one raw-connection transaction with the tenant
 *  + search-module GUCs set (ledger RLS satisfied on this same connection) and the engagement +
 *  cache-key advisory locks held for its duration. COMMIT on success, ROLLBACK on throw. */
export async function runInCacheCriticalSection<T>(
  tenantId: string,
  engagementId: string,
  cacheKey: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    // Tenant + module scope so search_provider_calls (RLS) reads/writes work on THIS connection —
    // same GUC contract as withTenants([tenantId], { modules: ['search'] }).
    await c.query("SELECT set_config('app.current_tenant_ids', $1, true)", [tenantId]);
    await c.query("SELECT set_config('app.scopes', 'search', true)");
    // Fixed lock order: engagement (spend serialization) then cache-key (single-flight).
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [SEARCH_ENG_LOCK_NS, engagementId]);
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [SEARCH_CACHE_LOCK_NS, cacheKey]);
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}
