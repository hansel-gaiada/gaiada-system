// M5-V3-e — the three consented-visitor jobs (design 2026-10-12 §4.2 steps 3-5, §4.7; schema V3-d,
// migrations/202610131600_search_visitor_profiles.sql):
//   INGEST  every 10 min  pull the collector's consented events, keep only what WebDesk's consent log proves.
//   SWEEP   hourly        every live profile's consent id -> consent.status; anything not `analytics:true` is withdrawn.
//   PURGE   daily         profiles 14 months after the last visit; tombstones 14 months after they were written.
//
// DARK BY DEFAULT. `SEARCH_VISITORS_ENABLED` must be exactly "1": unset, empty, "0", "true" all leave every job OFF and
// `startVisitorJobs` returns null BEFORE it creates a timer, opens a connection or makes a request. Intervals
// (`SEARCH_VISITORS_{INGEST,SWEEP,PURGE}_INTERVAL_MS`) that are empty, 0, junk or under a minute take the default
// (never a 0 ms busy loop: §9 trap 3). The sweep is capped at one hour and the purge at one day, so a typo cannot
// stretch the withdrawal promise ("gone within one sweep", §4.7) or the retention promise.
//
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE ORDERING (why a withdrawn visitor can never come back and a never-consented one never appears)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Two remote systems decide two different things: WebDesk's consent log decides WHETHER a person consented (D5), the
// collector's buffer holds WHAT they did. The ERP is the only place both meet, so the ERP serialises them:
//
// 1. ONE LOCK PER PROPERTY. Ingest, sweep and the score refresh all run inside a session advisory lock
//    (0x53430005, hashtext(property id)) held on a dedicated connection for the WHOLE unit of work, network calls
//    included. Ingest tries once and skips when busy; the sweep WAITS for it (default 5 min). So a sweep that starts
//    while ingest is writing a visitor's pre-withdrawal events runs AFTER that ingest commits, sees the profile, asks
//    WebDesk afresh and deletes it. Order: ingest(commit) -> sweep(delete + tombstone + forget). No profile remains.
//    `withVisitorPropertyLock` is exported so V3-h's erase path takes the same lock.
// 2. CONSENT IS ASKED INSIDE THE LOCK, PER PAGE, AFTER THE PAGE IS READ. Every distinct consent id on a page goes to
//    consent.status. A consent id whose LATEST record is not literally `analytics:true` (an `update` with
//    analytics:false is a withdrawal, §9 trap 6) or that has no record at all is never ingested.
// 3. WITHDRAWALS COMMIT FIRST (transaction A). For those ids the profiles are deleted (events cascade), the visitor
//    ids are tombstoned (sha256 of the lower-case uuid text, V3-d's hash contract, computed in SQL exactly as the
//    trigger computes it) and committed BEFORE anything else happens. The ERP side never waits on the collector.
// 4. THEN THE COLLECTOR IS TOLD (forget). Withdrawn visitors, absent consent ids, and any buffered event of an
//    already-tombstoned visitor or consent. If forget fails, the page stops here: transaction B never runs and the
//    cursor does not move, so the next run re-reads the page and re-sends forget (it is idempotent). The ids also go
//    to an in-memory retry queue flushed at the start of the property's next run (the sweep has no other way back
//    to them: tombstones are hashes).
// 5. INGEST COMMITS LAST (transaction B), and RE-CHECKS THE TOMBSTONES INSIDE THAT TRANSACTION, under the same lock,
//    immediately before writing. Anything tombstoned since step 2 (by step 3, by a rights request, by anything) is
//    skipped. The cursor advances in this same transaction, so events and cursor move together or not at all.
// 6. THE DATABASE IS THE LAST LINE. V3-d's trigger refuses to create or re-key a profile whose visitor or consent id is
//    tombstoned. A writer that tombstones without the lock between step 5's check and its insert makes transaction B
//    fail whole (nothing partial, cursor unmoved); the next run's re-check skips the visitor.
//
// WHICH WAY EACH OUTAGE FAILS
//   WebDesk unreachable / refusing / site unresolved / malformed answer:
//     ingest: nothing is written, nothing forgotten, nothing tombstoned, the cursor stays (an outage proves neither
//             consent nor withdrawal; the 72 h buffer waits). Typed failure in last_outcome.
//     sweep:  profiles whose consent cannot be checked are KEPT (deleting everyone on a blip is not a withdrawal), the
//             failure is recorded and logged as an error; batches already answered are fully applied (a proven
//             withdrawal is always applied). Ingest is blocked by the same outage, so nothing grows meanwhile.
//   Collector unreachable / refusing:
//     ingest: no page is read; or, mid-page, withdrawals are already committed in the ERP and the rest of the page
//             waits (cursor unmoved). Typed failure.
//     sweep:  ERP deletion and tombstones are committed regardless; the forget is queued for retry and the failure
//             recorded. The browser's own /lib/kestrel/f and the 72 h buffer purge bound what stays on the collector.
//   Collector keys not configured: ingest does not run (one log line per run); the sweep still deletes in the ERP.
//
// TENANCY. Every read and write of the visitor tables goes through withTenants([tenant], fn, {modules:['search']})
// (FORCE RLS; an unset scope would read zero rows silently). The sweep and purge run for EVERY company that has rows,
// whether or not `search` is still enabled for it: switching the module off must never freeze a withdrawal.
//
// NOTHING PERSONAL IN LOGS. Log lines and last_outcome carry property ids, counts and typed outcomes only; never a
// visitor id, consent id, path or key.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, withGlobal, withTenants, newId } from "../../db";
import { isModuleEnabled } from "../registry";
import {
  EVENTS_PAGE_MAX, InsightsError, forgetAtCollector, insightsSettings, readEventsPage,
  type CollectorEvent, type ForgetMode, type InsightsOpts,
} from "./insights-client";
import {
  ConsentStatusError, createConsentReader, hasAnalyticsConsent, type ConsentReader, type ConsentStatusEntry,
} from "./visitor-consent-client";
import { summarizeVisitor, type InterestRule, type ScoredEvent } from "./visitor-scoring";

// ── env ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const VISITORS_ENABLED_ENV = "SEARCH_VISITORS_ENABLED";
export const VISITORS_INGEST_INTERVAL_ENV = "SEARCH_VISITORS_INGEST_INTERVAL_MS";
export const VISITORS_SWEEP_INTERVAL_ENV = "SEARCH_VISITORS_SWEEP_INTERVAL_MS";
export const VISITORS_PURGE_INTERVAL_ENV = "SEARCH_VISITORS_PURGE_INTERVAL_MS";
export const DEFAULT_INGEST_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PURGE_INTERVAL_MS = 24 * 3600 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

/** ON only for the exact string "1". */
export function isVisitorJobsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VISITORS_ENABLED_ENV] === "1";
}

/** Empty, junk, 0 or sub-minute => the default; above `max` => `max`. Never 0. */
export function intervalFromEnv(env: NodeJS.ProcessEnv, name: string, def: number, max = Number.POSITIVE_INFINITY): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MS) return def;
  return Math.min(Math.floor(n), max);
}

export function visitorIntervals(env: NodeJS.ProcessEnv = process.env): { ingestMs: number; sweepMs: number; purgeMs: number } {
  return {
    ingestMs: intervalFromEnv(env, VISITORS_INGEST_INTERVAL_ENV, DEFAULT_INGEST_INTERVAL_MS),
    sweepMs: intervalFromEnv(env, VISITORS_SWEEP_INTERVAL_ENV, DEFAULT_SWEEP_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS),
    purgeMs: intervalFromEnv(env, VISITORS_PURGE_INTERVAL_ENV, DEFAULT_PURGE_INTERVAL_MS, DEFAULT_PURGE_INTERVAL_MS),
  };
}

// ── constants ──────────────────────────────────────────────────────────────────────────────────────────────────
export const VISITOR_LOCK_NS = 0x53430005; // 'SC' + 5: distinct from the scheduler (…03) and the decay job (…04)
export const RETENTION_SQL_INTERVAL = "14 months";
const S = { modules: ["search"] };
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_SWEEP_LOCK_WAIT_MS = 5 * 60 * 1000;
const LOCK_POLL_MS = 200;
const REFRESH_BATCH = 500;
const PENDING_MAX_IDS = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICES = new Set(["desktop", "mobile", "tablet", "unknown"]);
const DATA_KEYS = new Set(["section_id", "link_location", "form_id", "step_index", "language_to"]);
const COMPANY_KEYS = ["kind", "name", "domain", "confidence", "source", "version"] as const;

/** V3-d's hash contract, in Node (the jobs compute it in SQL; this is for tests and for V3-h). */
export function idHash(id: string): Buffer {
  return createHash("sha256").update(id.toLowerCase(), "utf8").digest();
}

export interface VisitorJobDeps {
  insights?: InsightsOpts;
  consent?: ConsentReader;
  now?: () => Date;
  /** Ingest: pages per property per run (default 10) and rows per page (default and max 1000). */
  maxPages?: number;
  pageLimit?: number;
  /** Sweep: how long to wait for a property's lock (default 5 min). */
  sweepLockWaitMs?: number;
  /** Tests: restrict a run to these companies. */
  tenantIds?: string[];
}

export interface PropRef { tenantId: string; propertyId: string; domain: string; website: string | null }

// ── the lock ───────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn` while holding the property's session advisory lock on a dedicated connection. `waitMs` 0 = try once.
 * Returns `{acquired:false}` without running `fn` when the lock stays busy. If the unlock cannot be confirmed the
 * connection is DESTROYED rather than returned to the pool, so a leaked lock can never outlive this call.
 */
export async function withVisitorPropertyLock<T>(
  propertyId: string, fn: () => Promise<T>, opts: { waitMs?: number; pollMs?: number } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await getPool().connect();
  let destroy = false;
  try {
    const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
    for (;;) {
      let locked: boolean;
      try {
        const r = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::int, hashtext($2::text)) AS locked", [VISITOR_LOCK_NS, propertyId]);
        locked = r.rows[0]?.locked === true;
      } catch (err) {
        destroy = true; // the lock state of this session is unknown: never hand it back to the pool
        throw err;
      }
      if (locked) break;
      const left = deadline - Date.now();
      if (left <= 0) return { acquired: false };
      await sleep(Math.min(opts.pollMs ?? LOCK_POLL_MS, left));
    }
    try {
      return { acquired: true, value: await fn() };
    } finally {
      try {
        const u = await client.query<{ ok: boolean }>("SELECT pg_advisory_unlock($1::int, hashtext($2::text)) AS ok", [VISITOR_LOCK_NS, propertyId]);
        if (u.rows[0]?.ok !== true) destroy = true;
      } catch {
        destroy = true;
      }
    }
  } finally {
    client.release(destroy ? true : undefined);
  }
}

// ── the forget retry queue (memory only; ids never logged) ─────────────────────────────────────────────────────
interface PendingForget { website: string; mode: ForgetMode; visitorIds: Set<string>; consentIds: Set<string> }
const pendingForgets = new Map<string, PendingForget>(); // key: `${propertyId}|${mode}`

function pendingSize(): number {
  let n = 0;
  for (const p of pendingForgets.values()) n += p.visitorIds.size + p.consentIds.size;
  return n;
}
export function pendingForgetCount(): number { return pendingSize(); }
export function clearPendingForgetsForTests(): void { pendingForgets.clear(); }

function enqueueForget(propertyId: string, website: string, mode: ForgetMode, visitorIds: Iterable<string>, consentIds: Iterable<string>): void {
  const key = `${propertyId}|${mode}`;
  const e = pendingForgets.get(key) ?? { website, mode, visitorIds: new Set<string>(), consentIds: new Set<string>() };
  let dropped = 0;
  for (const v of visitorIds) { if (pendingSize() < PENDING_MAX_IDS) e.visitorIds.add(v); else dropped++; }
  for (const c of consentIds) { if (pendingSize() < PENDING_MAX_IDS) e.consentIds.add(c); else dropped++; }
  pendingForgets.set(key, e);
  if (dropped > 0) console.error(`[SEARCH-VISITORS] forget retry queue full: ${dropped} id(s) not queued for property ${propertyId}`);
}

export interface ForgetLists { withdraw: { visitorIds: Set<string>; consentIds: Set<string> }; erase: { visitorIds: Set<string>; consentIds: Set<string> } }
const emptyLists = (): ForgetLists => ({
  withdraw: { visitorIds: new Set(), consentIds: new Set() },
  erase: { visitorIds: new Set(), consentIds: new Set() },
});
const listsSize = (l: ForgetLists) => l.withdraw.visitorIds.size + l.withdraw.consentIds.size + l.erase.visitorIds.size + l.erase.consentIds.size;

/** Sends forget for both modes. On failure the ids are queued for retry and the typed error is rethrown. */
async function sendForgets(p: PropRef, lists: ForgetLists, deps: VisitorJobDeps): Promise<number> {
  if (listsSize(lists) === 0) return 0;
  if (!p.website) throw new InsightsError("not_found", "the property has no collector website id");
  let calls = 0;
  for (const mode of ["erase", "withdraw"] as const) {
    const l = lists[mode];
    if (l.visitorIds.size + l.consentIds.size === 0) continue;
    try {
      calls += (await forgetAtCollector(p.website, { visitorIds: [...l.visitorIds], consentIds: [...l.consentIds] }, mode, deps.insights)).calls;
    } catch (err) {
      enqueueForget(p.propertyId, p.website, mode, l.visitorIds, l.consentIds);
      throw err;
    }
  }
  return calls;
}

/** Re-sends whatever an earlier run could not deliver for this property. Throws (typed) when it still cannot. */
async function flushPendingForgets(p: PropRef, deps: VisitorJobDeps): Promise<number> {
  let calls = 0;
  for (const mode of ["erase", "withdraw"] as const) {
    const key = `${p.propertyId}|${mode}`;
    const e = pendingForgets.get(key);
    if (!e) continue;
    calls += (await forgetAtCollector(e.website, { visitorIds: [...e.visitorIds], consentIds: [...e.consentIds] }, mode, deps.insights)).calls;
    pendingForgets.delete(key);
  }
  return calls;
}

// ── outcomes ───────────────────────────────────────────────────────────────────────────────────────────────────
export type VisitorOutcome =
  | "ok" | "busy" | "no_website" | "error" | "tombstoned_during_write"
  | `collector_${InsightsError["kind"]}` | `consent_${ConsentStatusError["kind"]}`;

function isTombstoneRefusal(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "23514" && typeof e.message === "string" && e.message.includes("tombstoned");
}

export function outcomeOf(err: unknown): VisitorOutcome {
  if (err instanceof InsightsError) return `collector_${err.kind}`;
  if (err instanceof ConsentStatusError) return `consent_${err.kind}`;
  if (isTombstoneRefusal(err)) return "tombstoned_during_write";
  return "error";
}

const OUTCOME_WORDS: Record<string, string> = {
  ok: "ok",
  busy: "another visitor job held the property",
  no_website: "the property has no collector website id",
  error: "an internal error stopped the run",
  tombstoned_during_write: "a visitor was withdrawn while the page was being written; the page will be retried",
  collector_not_configured: "the insights collector is not configured",
  collector_unreachable: "the insights collector is unreachable",
  collector_rejected: "the insights collector refused the key",
  collector_not_found: "the insights collector does not know this website",
  collector_bad_response: "the insights collector answered off-contract",
  consent_not_configured: "the WebDesk control channel is not configured",
  consent_unreachable: "WebDesk consent.status is unreachable",
  consent_rejected: "WebDesk refused the control credential",
  consent_site_unresolved: "no single WebDesk site of this company serves the property's domain",
  consent_bad_response: "WebDesk consent.status answered off-contract",
};
export function describeOutcome(phase: "ingest" | "sweep" | "refresh", outcome: VisitorOutcome): string {
  return `${phase}: ${OUTCOME_WORDS[outcome] ?? outcome}`.slice(0, 200);
}

function logFailure(phase: string, propertyId: string, outcome: VisitorOutcome, err?: unknown): void {
  const e = err as { name?: string; code?: string } | undefined;
  const tail = outcome === "error" && e ? ` (${e.name ?? "Error"}${e.code ? ` ${e.code}` : ""})` : "";
  console.error(`[SEARCH-VISITORS] ${phase} property ${propertyId}: ${outcome}${tail}`);
}

/** last_run_at + last_outcome, never the cursor or last_ok_at. Best effort: a failure to record never masks the cause. */
async function recordFailure(p: PropRef, phase: "ingest" | "sweep" | "refresh", outcome: VisitorOutcome, now: Date): Promise<void> {
  try {
    await withTenants([p.tenantId], (c) => c.query(
      `INSERT INTO search_visitor_ingest_state (tenant_id, property_id, last_run_at, last_outcome) VALUES ($1,$2,$3,$4)
       ON CONFLICT (property_id) DO UPDATE SET last_run_at = EXCLUDED.last_run_at, last_outcome = EXCLUDED.last_outcome`,
      [p.tenantId, p.propertyId, now, describeOutcome(phase, outcome)],
    ), S);
  } catch (err) {
    logFailure(`${phase}/record`, p.propertyId, "error", err);
  }
}

// ── shared SQL ─────────────────────────────────────────────────────────────────────────────────────────────────
interface TombstoneHits { visitors: Map<string, "withdraw" | "erase">; consents: Map<string, "withdraw" | "erase"> }

/** Which of these ids are tombstoned for the property. The hash is computed in SQL, exactly as V3-d's trigger does. */
async function readTombstones(c: PoolClient, p: PropRef, visitorIds: string[], consentIds: string[]): Promise<TombstoneHits> {
  const out: TombstoneHits = { visitors: new Map(), consents: new Map() };
  if (visitorIds.length === 0 && consentIds.length === 0) return out;
  const { rows } = await c.query<{ id: string; kind: "visitor" | "consent"; reason: "withdraw" | "erase" }>(
    `SELECT v::text AS id, 'visitor' AS kind, t.reason FROM unnest($3::uuid[]) AS v
       JOIN search_visitor_tombstones t ON t.tenant_id = $1 AND t.property_id = $2 AND t.kind = 'visitor'
        AND t.id_hash = sha256(convert_to(v::text, 'UTF8'))
     UNION ALL
     SELECT k::text AS id, 'consent' AS kind, t.reason FROM unnest($4::uuid[]) AS k
       JOIN search_visitor_tombstones t ON t.tenant_id = $1 AND t.property_id = $2 AND t.kind = 'consent'
        AND t.id_hash = sha256(convert_to(k::text, 'UTF8'))`,
    [p.tenantId, p.propertyId, visitorIds, consentIds],
  );
  for (const r of rows) {
    const m = r.kind === "visitor" ? out.visitors : out.consents;
    if (m.get(r.id) !== "erase") m.set(r.id, r.reason); // erase wins over withdraw
  }
  return out;
}

/** Deletes the matching profiles (events cascade) and tombstones every affected visitor id. Returns the deleted visitor ids. */
async function withdrawProfiles(c: PoolClient, p: PropRef, visitorIds: string[], consentIds: string[]): Promise<{ deleted: number; tombstoned: string[] }> {
  if (visitorIds.length === 0 && consentIds.length === 0) return { deleted: 0, tombstoned: [] };
  const del = await c.query<{ visitor_id: string }>(
    `DELETE FROM search_visitor_profiles
      WHERE tenant_id = $1 AND property_id = $2 AND (visitor_id = ANY($3::uuid[]) OR consent_id = ANY($4::uuid[]))
      RETURNING visitor_id::text AS visitor_id`,
    [p.tenantId, p.propertyId, visitorIds, consentIds],
  );
  const tomb = [...new Set([...visitorIds, ...del.rows.map((r) => r.visitor_id)])];
  if (tomb.length > 0) {
    await c.query(
      `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason)
       SELECT $1::uuid, $2::uuid, 'visitor', sha256(convert_to(v::text, 'UTF8')), 'withdraw' FROM unnest($3::uuid[]) AS v
       ON CONFLICT (property_id, kind, id_hash) DO NOTHING`,
      [p.tenantId, p.propertyId, tomb],
    );
  }
  return { deleted: del.rowCount ?? 0, tombstoned: tomb };
}

async function loadRules(c: PoolClient, p: PropRef): Promise<InterestRule[]> {
  const { rows } = await c.query<InterestRule>(
    `SELECT match, pattern, facet, tag, weight FROM search_interest_rules WHERE tenant_id = $1 AND property_id = $2`,
    [p.tenantId, p.propertyId],
  );
  return rows.map((r) => ({ ...r, weight: Number(r.weight) }));
}

async function loadProfileEvents(c: PoolClient, profileId: string): Promise<ScoredEvent[]> {
  const { rows } = await c.query<{ occurred_at: Date; kind: "pageview" | "event"; path: string | null; name: string | null; data: Record<string, unknown> | null }>(
    `SELECT occurred_at, kind, path, name, data FROM search_visitor_events WHERE profile_id = $1`, [profileId],
  );
  return rows.map((r) => ({ occurredAt: new Date(r.occurred_at), kind: r.kind, path: r.path, name: r.name, data: r.data }));
}

async function writeSummary(c: PoolClient, profileId: string, events: ScoredEvent[], rules: InterestRule[], now: Date, latest: ProfileAttrs | null): Promise<void> {
  const s = summarizeVisitor(events, rules, now);
  if (!s.firstSeenAt || !s.lastSeenAt) return;
  const sets = [
    "first_seen_at = $2", "last_seen_at = $3", "visits = $4", "pageviews = $5", "interests = $6::jsonb",
    "score = $7", "score_parts = $8::jsonb", "updated_at = $9",
  ];
  const args: unknown[] = [profileId, s.firstSeenAt, s.lastSeenAt, s.visits, s.pageviews, JSON.stringify(s.interests), s.score, JSON.stringify(s.scoreParts), now];
  if (latest) {
    args.push(latest.device, latest.country, latest.city, latest.network === null ? null : JSON.stringify(latest.network), latest.company === null ? null : JSON.stringify(latest.company));
    sets.push("device = $10", "country = $11", "city = $12", "network = $13::jsonb", "company = $14::jsonb");
  }
  await c.query(`UPDATE search_visitor_profiles SET ${sets.join(", ")} WHERE id = $1`, args);
}

// ── sanitising one collector event to V3-d's CHECKs (a bad row is dropped, never allowed to fail a page) ───────
interface EventRow { collectorId: number; occurredAt: Date; kind: "pageview" | "event"; path: string | null; name: string | null; data: string | null }
interface ProfileAttrs { device: string; country: string | null; city: string | null; network: Record<string, unknown> | null; company: Record<string, unknown> | null }

function okPath(p: string | null): p is string {
  return typeof p === "string" && p.length >= 1 && p.length <= 512 && p.startsWith("/") && !p.includes("?") && !p.includes("#");
}

export function sanitizeEvent(e: CollectorEvent): EventRow | null {
  const t = Date.parse(e.occurredAt);
  const at = Number.isFinite(t) ? new Date(t) : Number.isFinite(Date.parse(e.receivedAt)) ? new Date(Date.parse(e.receivedAt)) : null;
  if (!at) return null;
  const path = okPath(e.path) ? e.path : null;
  const name = typeof e.name === "string" && e.name.length >= 1 && [...e.name].length <= 50 ? e.name : null;
  if (e.kind === "pageview" && !path) return null;
  if (e.kind === "event" && !name) return null;
  let data: string | null = null;
  if (e.data) {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.data)) {
      if (!DATA_KEYS.has(k)) continue;
      if (typeof v === "string" && v.length <= 200) kept[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) kept[k] = v;
    }
    const json = JSON.stringify(kept);
    if (Object.keys(kept).length > 0 && Buffer.byteLength(json) <= 700) data = json;
  }
  return { collectorId: e.id, occurredAt: at, kind: e.kind, path, name: e.kind === "event" ? name : null, data };
}

const short = (v: unknown, n = 200): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, n) : null);

export function profileAttrsOf(e: CollectorEvent): ProfileAttrs {
  const device = e.device && DEVICES.has(e.device) ? e.device : "unknown";
  const cc = typeof e.geo?.country === "string" ? e.geo.country.toUpperCase() : null;
  const country = cc && /^[A-Z]{2}$/.test(cc) ? cc : null;
  const city = e.geo?.city ? [...e.geo.city].slice(0, 120).join("") || null : null;
  const network = e.network && (e.network.asn !== null || e.network.name)
    ? { kind: "network", asn: e.network.asn, name: short(e.network.name) }
    : null;
  let company: Record<string, unknown> | null = null;
  if (e.company) {
    const c: Record<string, unknown> = {};
    for (const k of COMPANY_KEYS) { const v = short(e.company[k]); if (v) c[k] = v; }
    company = Object.keys(c).length > 0 ? c : null;
  }
  return { device, country, city, network, company };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// INGEST
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface IngestPropertyResult {
  propertyId: string;
  outcome: VisitorOutcome;
  pages: number;
  eventsInserted: number;
  profilesCreated: number;
  /** profiles deleted and visitor ids tombstoned because their consent is withdrawn or absent */
  withdrawnProfiles: number;
  skippedNoConsent: number;
  skippedTombstoned: number;
  skippedMismatch: number;
  invalid: number;
  forgetCalls: number;
}

/** Transaction A: apply every withdrawal the page proves, then say which ids the collector must forget. */
async function applyPageWithdrawals(p: PropRef, events: CollectorEvent[], statuses: Map<string, ConsentStatusEntry>): Promise<{ deleted: number; forget: ForgetLists; noConsentEvents: number }> {
  const consentIds = [...new Set(events.map((e) => e.consentId))];
  const withdrawnConsents = consentIds.filter((c) => !hasAnalyticsConsent(statuses.get(c)));
  const absentConsents = consentIds.filter((c) => !statuses.has(c));
  const withdrawnSet = new Set(withdrawnConsents);
  const noConsent = events.filter((e) => withdrawnSet.has(e.consentId));
  const withdrawnVisitors = [...new Set(noConsent.map((e) => e.visitorId))];
  const visitorIds = [...new Set(events.map((e) => e.visitorId))];

  return withTenants([p.tenantId], async (c) => {
    const w = await withdrawProfiles(c, p, withdrawnVisitors, withdrawnConsents);
    const tombs = await readTombstones(c, p, visitorIds, consentIds);
    const forget = emptyLists();
    for (const v of w.tombstoned) forget.withdraw.visitorIds.add(v);
    for (const k of absentConsents) forget.withdraw.consentIds.add(k);
    // a buffered event of an already-tombstoned visitor or consent: tell the collector again (it may have missed it)
    for (const e of events) {
      const reason = tombs.visitors.get(e.visitorId) === "erase" || tombs.consents.get(e.consentId) === "erase" ? "erase"
        : tombs.visitors.has(e.visitorId) || tombs.consents.has(e.consentId) ? "withdraw" : null;
      if (!reason) continue;
      forget[reason].visitorIds.add(e.visitorId);
      if (tombs.consents.has(e.consentId)) forget[reason].consentIds.add(e.consentId);
    }
    for (const v of forget.erase.visitorIds) forget.withdraw.visitorIds.delete(v);
    return { deleted: w.deleted, forget, noConsentEvents: noConsent.length };
  }, S);
}

/** Transaction B: re-check tombstones, write the consented events and profiles, advance the cursor. */
async function applyPageIngest(
  p: PropRef, events: CollectorEvent[], statuses: Map<string, ConsentStatusEntry>, nextCursor: number, now: Date,
  r: IngestPropertyResult,
): Promise<void> {
  await withTenants([p.tenantId], async (c) => {
    const tombs = await readTombstones(c, p, [...new Set(events.map((e) => e.visitorId))], [...new Set(events.map((e) => e.consentId))]);
    const byVisitor = new Map<string, CollectorEvent[]>();
    for (const e of events) {
      if (!hasAnalyticsConsent(statuses.get(e.consentId))) continue; // counted in transaction A
      if (tombs.visitors.has(e.visitorId) || tombs.consents.has(e.consentId)) { r.skippedTombstoned++; continue; }
      const g = byVisitor.get(e.visitorId) ?? [];
      g.push(e);
      byVisitor.set(e.visitorId, g);
    }
    let rules: InterestRule[] | null = null;
    for (const [visitorId, group] of byVisitor) {
      group.sort((a, b) => a.id - b.id);
      const existing = await c.query<{ id: string; consent_id: string; last_seen_at: Date }>(
        `SELECT id, consent_id::text AS consent_id, last_seen_at FROM search_visitor_profiles
          WHERE tenant_id = $1 AND property_id = $2 AND visitor_id = $3 FOR UPDATE`,
        [p.tenantId, p.propertyId, visitorId],
      );
      const prof = existing.rows[0] ?? null;
      const consentId = prof?.consent_id ?? group[0]!.consentId;
      const rows: Array<{ ev: CollectorEvent; row: EventRow }> = [];
      for (const ev of group) {
        if (ev.consentId !== consentId) { r.skippedMismatch++; continue; } // I3: one visitor id belongs to one consent id
        const row = sanitizeEvent(ev);
        if (!row) { r.invalid++; continue; }
        rows.push({ ev, row });
      }
      if (rows.length === 0) continue;
      const times = rows.map((x) => x.row.occurredAt.getTime());
      let profileId = prof?.id ?? null;
      let created = false;
      if (!profileId) {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO search_visitor_profiles (id, tenant_id, property_id, visitor_id, consent_id, first_seen_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [newId(), p.tenantId, p.propertyId, visitorId, consentId, new Date(Math.min(...times)), new Date(Math.max(...times))],
        );
        profileId = ins.rows[0]!.id;
        created = true;
        r.profilesCreated++;
      }
      const inserted = await c.query<{ collector_event_id: string }>(
        `INSERT INTO search_visitor_events (id, tenant_id, property_id, profile_id, collector_event_id, occurred_at, kind, path, name, data)
         SELECT u.id, $1::uuid, $2::uuid, $3::uuid, u.cid, u.at, u.kind, u.path, u.name, u.data::jsonb
           FROM unnest($4::uuid[], $5::bigint[], $6::timestamptz[], $7::text[], $8::text[], $9::text[], $10::text[])
                AS u(id, cid, at, kind, path, name, data)
         ON CONFLICT (property_id, collector_event_id) DO NOTHING
         RETURNING collector_event_id::text`,
        [
          p.tenantId, p.propertyId, profileId,
          rows.map(() => newId()), rows.map((x) => String(x.row.collectorId)), rows.map((x) => x.row.occurredAt.toISOString()),
          rows.map((x) => x.row.kind), rows.map((x) => x.row.path), rows.map((x) => x.row.name), rows.map((x) => x.row.data),
        ],
      );
      const n = inserted.rowCount ?? 0;
      r.eventsInserted += n;
      if (n === 0 && !created) continue; // a repeated batch: nothing changes
      const newIds = new Set(inserted.rows.map((x) => Number(x.collector_event_id)));
      const newest = rows.filter((x) => newIds.has(x.row.collectorId)).sort((a, b) => b.row.occurredAt.getTime() - a.row.occurredAt.getTime())[0];
      const attrs = newest && (created || !prof || newest.row.occurredAt.getTime() >= new Date(prof.last_seen_at).getTime()) ? profileAttrsOf(newest.ev) : null;
      rules ??= await loadRules(c, p);
      await writeSummary(c, profileId, await loadProfileEvents(c, profileId), rules, now, attrs);
    }
    await c.query(
      `INSERT INTO search_visitor_ingest_state (tenant_id, property_id, cursor, last_run_at, last_ok_at, last_outcome)
       VALUES ($1,$2,$3,$4,$4,$5)
       ON CONFLICT (property_id) DO UPDATE SET cursor = GREATEST(search_visitor_ingest_state.cursor, EXCLUDED.cursor),
         last_run_at = EXCLUDED.last_run_at, last_ok_at = EXCLUDED.last_ok_at, last_outcome = EXCLUDED.last_outcome`,
      [p.tenantId, p.propertyId, nextCursor, now, describeOutcome("ingest", "ok")],
    );
  }, S);
}

async function readCursor(p: PropRef): Promise<number> {
  const { rows } = await withTenants([p.tenantId], (c) => c.query<{ cursor: string }>(
    `SELECT cursor::text AS cursor FROM search_visitor_ingest_state WHERE property_id = $1 AND tenant_id = $2`, [p.propertyId, p.tenantId],
  ), S);
  return rows[0] ? Number(rows[0].cursor) : 0;
}

async function recordOk(p: PropRef, cursor: number, now: Date): Promise<void> {
  await withTenants([p.tenantId], (c) => c.query(
    `INSERT INTO search_visitor_ingest_state (tenant_id, property_id, cursor, last_run_at, last_ok_at, last_outcome)
     VALUES ($1,$2,$3,$4,$4,$5)
     ON CONFLICT (property_id) DO UPDATE SET cursor = GREATEST(search_visitor_ingest_state.cursor, EXCLUDED.cursor),
       last_run_at = EXCLUDED.last_run_at, last_ok_at = EXCLUDED.last_ok_at, last_outcome = EXCLUDED.last_outcome`,
    [p.tenantId, p.propertyId, cursor, now, describeOutcome("ingest", "ok")],
  ), S);
}

/** One property's ingest, under its lock (tried once: a busy property is simply picked up next run). */
export async function ingestProperty(p: PropRef, deps: VisitorJobDeps = {}): Promise<IngestPropertyResult> {
  const now = (deps.now ?? (() => new Date()))();
  const consent = deps.consent ?? createConsentReader();
  const limit = Math.max(1, Math.min(EVENTS_PAGE_MAX, deps.pageLimit ?? EVENTS_PAGE_MAX));
  const r: IngestPropertyResult = {
    propertyId: p.propertyId, outcome: "ok", pages: 0, eventsInserted: 0, profilesCreated: 0, withdrawnProfiles: 0,
    skippedNoConsent: 0, skippedTombstoned: 0, skippedMismatch: 0, invalid: 0, forgetCalls: 0,
  };
  if (!p.website || !UUID_RE.test(p.website)) { r.outcome = "no_website"; return r; }
  const lock = await withVisitorPropertyLock(p.propertyId, async () => {
    try {
      r.forgetCalls += await flushPendingForgets(p, deps);
      let cursor = await readCursor(p);
      let siteSlug: string | null = null;
      for (let i = 0; i < (deps.maxPages ?? DEFAULT_MAX_PAGES); i++) {
        const page = await readEventsPage(p.website!, cursor, limit, deps.insights);
        r.invalid += page.malformed;
        const next = page.next !== null && page.next > cursor ? page.next : cursor;
        if (page.events.length === 0) {
          // nothing attributable: only unattributable rows (if any) to move past; the next run carries on from there
          if (next > cursor) { await recordOk(p, next, now); cursor = next; }
          break;
        }
        r.pages++;
        siteSlug ??= await consent.resolveSiteSlug(p.tenantId, p.domain);
        const statuses = await consent.statuses(p.tenantId, siteSlug, [...new Set(page.events.map((e) => e.consentId))]);
        // (A) withdrawals commit first; (B) forget; (C) the consented rows + cursor, re-checking tombstones.
        const a = await applyPageWithdrawals(p, page.events, statuses);
        r.withdrawnProfiles += a.deleted;
        r.skippedNoConsent += a.noConsentEvents;
        r.forgetCalls += await sendForgets(p, a.forget, deps);
        await applyPageIngest(p, page.events, statuses, next, now, r);
        cursor = next;
        if (page.events.length + page.malformed < limit) break;
      }
      await recordOk(p, cursor, now);
    } catch (err) {
      r.outcome = outcomeOf(err);
      logFailure("ingest", p.propertyId, r.outcome, err);
      await recordFailure(p, "ingest", r.outcome, now);
    }
  });
  if (!lock.acquired) r.outcome = "busy";
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// SWEEP
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface SweepPropertyResult {
  propertyId: string;
  outcome: VisitorOutcome;
  checked: number;
  withdrawnProfiles: number;
  /** profiles removed because a tombstone already covered them (a writer that did not delete) */
  tombstonedProfiles: number;
  forgetCalls: number;
  /** the forget could not be delivered (queued for retry); the ERP side was still applied */
  forgetOutcome: VisitorOutcome | null;
}

/** One property's sweep. WAITS for the lock, so a sweep that starts during an ingest runs right after it. */
export async function sweepProperty(p: PropRef, deps: VisitorJobDeps = {}): Promise<SweepPropertyResult> {
  const now = (deps.now ?? (() => new Date()))();
  const consent = deps.consent ?? createConsentReader();
  const r: SweepPropertyResult = { propertyId: p.propertyId, outcome: "ok", checked: 0, withdrawnProfiles: 0, tombstonedProfiles: 0, forgetCalls: 0, forgetOutcome: null };
  const forgetSafely = async (lists: ForgetLists) => {
    try {
      r.forgetCalls += await sendForgets(p, lists, deps);
    } catch (err) {
      r.forgetOutcome = outcomeOf(err); // queued for retry by sendForgets
      logFailure("sweep/forget", p.propertyId, r.forgetOutcome, err);
    }
  };
  const lock = await withVisitorPropertyLock(p.propertyId, async () => {
    try {
      try { r.forgetCalls += await flushPendingForgets(p, deps); } catch (err) { r.forgetOutcome = outcomeOf(err); }
      // (1) a profile a tombstone already covers is removed outright (the trigger stops re-creation; this stops survival)
      const consentIds = await withTenants([p.tenantId], async (c) => {
        const gone = await c.query<{ visitor_id: string }>(
          `DELETE FROM search_visitor_profiles sp
            WHERE sp.tenant_id = $1 AND sp.property_id = $2 AND EXISTS (
              SELECT 1 FROM search_visitor_tombstones t
               WHERE t.tenant_id = sp.tenant_id AND t.property_id = sp.property_id
                 AND ((t.kind = 'visitor' AND t.id_hash = sha256(convert_to(sp.visitor_id::text, 'UTF8')))
                   OR (t.kind = 'consent' AND t.id_hash = sha256(convert_to(sp.consent_id::text, 'UTF8')))))
            RETURNING visitor_id::text AS visitor_id`,
          [p.tenantId, p.propertyId],
        );
        r.tombstonedProfiles = gone.rowCount ?? 0;
        const { rows } = await c.query<{ consent_id: string }>(
          `SELECT DISTINCT consent_id::text AS consent_id FROM search_visitor_profiles WHERE tenant_id = $1 AND property_id = $2 ORDER BY 1`,
          [p.tenantId, p.propertyId],
        );
        return { ids: rows.map((x) => x.consent_id), gone: gone.rows.map((x) => x.visitor_id) };
      }, S);
      if (consentIds.gone.length > 0) {
        const l = emptyLists();
        for (const v of consentIds.gone) l.withdraw.visitorIds.add(v);
        await forgetSafely(l);
      }
      if (consentIds.ids.length === 0) return;
      // (2) consent.status, 100 ids at a time; each answered batch is applied completely before the next is asked
      const siteSlug = await consent.resolveSiteSlug(p.tenantId, p.domain);
      for (let i = 0; i < consentIds.ids.length; i += 100) {
        const batch = consentIds.ids.slice(i, i + 100);
        const st = await consent.statuses(p.tenantId, siteSlug, batch);
        r.checked += batch.length;
        const withdrawn = batch.filter((c) => !hasAnalyticsConsent(st.get(c)));
        if (withdrawn.length === 0) continue;
        const absent = withdrawn.filter((c) => !st.has(c));
        const w = await withTenants([p.tenantId], (c) => withdrawProfiles(c, p, [], withdrawn), S);
        r.withdrawnProfiles += w.deleted;
        const l = emptyLists();
        for (const v of w.tombstoned) l.withdraw.visitorIds.add(v);
        for (const k of absent) l.withdraw.consentIds.add(k);
        await forgetSafely(l);
      }
    } catch (err) {
      r.outcome = outcomeOf(err);
      logFailure("sweep", p.propertyId, r.outcome, err);
      await recordFailure(p, "sweep", r.outcome, now);
    }
  }, { waitMs: deps.sweepLockWaitMs ?? DEFAULT_SWEEP_LOCK_WAIT_MS });
  if (!lock.acquired) {
    r.outcome = "busy";
    logFailure("sweep", p.propertyId, "busy");
    await recordFailure(p, "sweep", "busy", now);
  } else if (r.outcome === "ok" && r.forgetOutcome) {
    await recordFailure(p, "sweep", r.forgetOutcome, now);
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PURGE (+ a bounded score refresh, because recency and the 90-day window move with the clock)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface PurgeTenantResult { profilesDeleted: number; tombstonesDeleted: number; refreshed: number }

/** Deletes ONLY profiles whose last visit is more than 14 months before `now`, and tombstones written more than 14
 *  months before `now`. Nothing else. No lock: a purged profile that ingest touches concurrently fails ingest's
 *  transaction whole (foreign key) and is simply re-created from the next consented page. */
export async function purgeTenant(tenantId: string, now: Date): Promise<{ profilesDeleted: number; tombstonesDeleted: number }> {
  return withTenants([tenantId], async (c) => {
    const p = await c.query(
      `DELETE FROM search_visitor_profiles WHERE tenant_id = $1 AND last_seen_at < ($2::timestamptz - interval '${RETENTION_SQL_INTERVAL}')`,
      [tenantId, now],
    );
    const t = await c.query(
      `DELETE FROM search_visitor_tombstones WHERE tenant_id = $1 AND created_at < ($2::timestamptz - interval '${RETENTION_SQL_INTERVAL}')`,
      [tenantId, now],
    );
    return { profilesDeleted: p.rowCount ?? 0, tombstonesDeleted: t.rowCount ?? 0 };
  }, S);
}

/** Recomputes interests and score for profiles seen in the last 91 days that were not updated in 20 h. */
export async function refreshProperty(p: PropRef, now: Date): Promise<number> {
  const lock = await withVisitorPropertyLock(p.propertyId, () => withTenants([p.tenantId], async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM search_visitor_profiles
        WHERE tenant_id = $1 AND property_id = $2
          AND last_seen_at >= ($3::timestamptz - interval '91 days') AND updated_at < ($3::timestamptz - interval '20 hours')
        ORDER BY updated_at ASC LIMIT ${REFRESH_BATCH}`,
      [p.tenantId, p.propertyId, now],
    );
    if (rows.length === 0) return 0;
    const rules = await loadRules(c, p);
    for (const { id } of rows) await writeSummary(c, id, await loadProfileEvents(c, id), rules, now, null);
    return rows.length;
  }, S));
  return lock.acquired ? lock.value : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// RUNS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface VisitorRunResult {
  notConfigured: boolean;
  tenants: number;
  properties: number;
  failed: number;
  busy: number;
  results: Array<IngestPropertyResult | SweepPropertyResult>;
}
const emptyRun = (): VisitorRunResult => ({ notConfigured: false, tenants: 0, properties: 0, failed: 0, busy: 0, results: [] });

async function companies(deps: VisitorJobDeps, includeDeleted: boolean): Promise<string[]> {
  const { rows } = await withGlobal((c) => c.query<{ id: string }>(
    `SELECT id FROM companies ${includeDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY created_at ASC`,
  ));
  const ids = rows.map((r) => r.id);
  return deps.tenantIds ? ids.filter((id) => deps.tenantIds!.includes(id)) : ids;
}

function tally(run: VisitorRunResult, res: IngestPropertyResult | SweepPropertyResult): void {
  run.properties++;
  run.results.push(res);
  if (res.outcome === "busy") run.busy++;
  else if (res.outcome !== "ok") run.failed++;
}

/** INGEST over every company with `search` on and every active property bound to a collector website. */
export async function runVisitorIngest(deps: VisitorJobDeps = {}): Promise<VisitorRunResult> {
  const run = emptyRun();
  const settings = deps.insights?.settings === undefined ? insightsSettings() : deps.insights.settings;
  if (!settings) { run.notConfigured = true; return run; }
  for (const tenantId of await companies(deps, false)) {
    try {
      if (!(await isModuleEnabled(tenantId, "search"))) continue;
      run.tenants++;
      const props = await withTenants([tenantId], async (c) => (await c.query<{ id: string; domain: string; umami_site_id: string }>(
        `SELECT id, domain, umami_site_id FROM search_properties
          WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL AND umami_site_id IS NOT NULL
          ORDER BY created_at ASC`, [tenantId],
      )).rows, S);
      for (const pr of props) {
        tally(run, await ingestProperty({ tenantId, propertyId: pr.id, domain: pr.domain, website: pr.umami_site_id }, deps));
      }
    } catch (err) {
      run.failed++;
      logFailure("ingest", `(tenant ${tenantId})`, "error", err);
    }
  }
  return run;
}

/** SWEEP over every property of every company that HAS profiles (module on or off, property live or not). */
export async function runVisitorSweep(deps: VisitorJobDeps = {}): Promise<VisitorRunResult> {
  const run = emptyRun();
  for (const tenantId of await companies(deps, true)) {
    try {
      const props = await withTenants([tenantId], async (c) => (await c.query<{ id: string; domain: string; umami_site_id: string | null }>(
        `SELECT sp.id, sp.domain, sp.umami_site_id FROM search_properties sp
          WHERE sp.tenant_id = $1 AND EXISTS (SELECT 1 FROM search_visitor_profiles v WHERE v.tenant_id = sp.tenant_id AND v.property_id = sp.id)
          ORDER BY sp.created_at ASC`, [tenantId],
      )).rows, S);
      if (props.length === 0) continue;
      run.tenants++;
      for (const pr of props) {
        tally(run, await sweepProperty({ tenantId, propertyId: pr.id, domain: pr.domain, website: pr.umami_site_id }, deps));
      }
    } catch (err) {
      run.failed++;
      logFailure("sweep", `(tenant ${tenantId})`, "error", err);
    }
  }
  return run;
}

export interface PurgeRunResult { tenants: number; profilesDeleted: number; tombstonesDeleted: number; refreshed: number; errors: number }

/** PURGE (retention) for every company, then the bounded score refresh. */
export async function runVisitorPurge(deps: VisitorJobDeps = {}): Promise<PurgeRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const out: PurgeRunResult = { tenants: 0, profilesDeleted: 0, tombstonesDeleted: 0, refreshed: 0, errors: 0 };
  for (const tenantId of await companies(deps, true)) {
    try {
      const d = await purgeTenant(tenantId, now);
      out.tenants++;
      out.profilesDeleted += d.profilesDeleted;
      out.tombstonesDeleted += d.tombstonesDeleted;
      const props = await withTenants([tenantId], async (c) => (await c.query<{ id: string; domain: string; umami_site_id: string | null }>(
        `SELECT sp.id, sp.domain, sp.umami_site_id FROM search_properties sp
          WHERE sp.tenant_id = $1 AND EXISTS (SELECT 1 FROM search_visitor_profiles v WHERE v.tenant_id = sp.tenant_id AND v.property_id = sp.id)`,
        [tenantId],
      )).rows, S);
      for (const pr of props) out.refreshed += await refreshProperty({ tenantId, propertyId: pr.id, domain: pr.domain, website: pr.umami_site_id }, now);
    } catch (err) {
      out.errors++;
      logFailure("purge", `(tenant ${tenantId})`, "error", err);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// LOOPS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface VisitorJobsHandle { stop: () => void; intervals: { ingestMs: number; sweepMs: number; purgeMs: number } }

/**
 * Starts the three loops. Returns null, with NO timer, NO connection and NO request, unless SEARCH_VISITORS_ENABLED is
 * exactly "1". Each loop is a chained setTimeout (a slow run never stacks) and fail-soft per tick.
 * Wired from main.ts beside startContentDecayLoop (see the V3-e report: main.ts is outside this ticket's paths).
 */
export function startVisitorJobs(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    initialDelayMs?: { ingest?: number; sweep?: number; purge?: number };
    ingest?: () => Promise<unknown>; sweep?: () => Promise<unknown>; purge?: () => Promise<unknown>;
  } = {},
): VisitorJobsHandle | null {
  if (!isVisitorJobsEnabled(env)) return null;
  const intervals = visitorIntervals(env);
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const loop = (name: string, everyMs: number, firstMs: number, run: () => Promise<unknown>) => {
    const tick = async () => {
      if (stopped) return;
      try {
        await run();
      } catch (err) {
        console.error(`[SEARCH-VISITORS] ${name} tick failed: ${(err as Error)?.name ?? "Error"}`);
      }
      if (!stopped) { const t = setTimeout(tick, everyMs); timers.add(t); }
    };
    const t = setTimeout(tick, firstMs);
    timers.add(t);
  };
  loop("ingest", intervals.ingestMs, opts.initialDelayMs?.ingest ?? 2 * 60 * 1000, opts.ingest ?? (async () => {
    const r = await runVisitorIngest();
    if (r.notConfigured) console.log("[SEARCH-VISITORS] ingest skipped: the insights collector is not configured");
    else if (r.failed > 0) console.log("[SEARCH-VISITORS] ingest:", { properties: r.properties, failed: r.failed, busy: r.busy });
  }));
  loop("sweep", intervals.sweepMs, opts.initialDelayMs?.sweep ?? 3 * 60 * 1000, opts.sweep ?? (async () => {
    const r = await runVisitorSweep();
    if (r.failed > 0 || r.busy > 0) console.error("[SEARCH-VISITORS] sweep:", { properties: r.properties, failed: r.failed, busy: r.busy });
  }));
  loop("purge", intervals.purgeMs, opts.initialDelayMs?.purge ?? 10 * 60 * 1000, opts.purge ?? (async () => {
    const r = await runVisitorPurge();
    if (r.profilesDeleted > 0 || r.errors > 0) console.log("[SEARCH-VISITORS] purge:", r);
  }));
  return {
    intervals,
    stop: () => { stopped = true; for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}
