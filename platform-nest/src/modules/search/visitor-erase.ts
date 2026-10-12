// M5-V3-h — the consented-visitor half of a G5 rights request (find / export / erase), called by
// core/agency-privacy.service.ts INSIDE its own transaction, after every WS4 refusal has been decided from stored state.
// Design 2026-10-12 §4.7 (rights request row), §8 V3-h; addendum §9.1 (profiles by visitor id, consent id, or a lead's
// consent id). Schema: migrations/202610131600 (profiles, events, tombstones) and 202610131900 (the ledger columns).
//
// WHO IS IN SCOPE. A request names the person by any of: the visitor id (the privacy page shows it, §4.1 I6), the
// consent id, or (email/phone requests) the consent id snapshotted on each lead that matched DIRECTLY (the lead's own
// contact is the subject: the same rule G5 uses for suppression; a lead matched only through an AD-1 answer carries the
// consent of whoever submitted the web form, who may be someone else). From those seeds the scope is CLOSED over the
// profiles: a matched profile adds its other id (a visitor id brings its consent id and vice versa), repeated until
// nothing new appears, so find shows exactly what erase removes and no profile sharing an erased id survives.
//
// ERASE, in the caller's transaction:
//   1. declares the `search` module scope for this transaction (app.scopes; the profile tables are module-walled, the
//      agency tables are not, so both are reachable in one transaction; declaration-based, so a tenant that has since
//      switched `search` off is still erased);
//   2. takes V3-e's per-property lock (0x53430005, hashtext(property id)) as a TRANSACTION-level advisory lock on EVERY
//      property of the tenant, in sorted order. Session and transaction advisory locks on the same key conflict, so
//      ingest, sweep and refresh (withVisitorPropertyLock) are excluded until this transaction ends, which is exactly
//      the window that matters: deletion and tombstones become visible to ingest only together, at commit. Polled
//      with a deadline (default 60 s); if it expires the caller's whole transaction rolls back (VisitorStoreBusyError)
//      and the approval stays unused, so the request can simply be run again;
//   3. deletes the profiles (events cascade) and tombstones BOTH kinds of id with reason 'erase' on EVERY property of
//      the tenant (events of this person may still sit in the collector's buffer for a property with no profile yet).
//      An existing 'withdraw' tombstone is upgraded to 'erase' and its 14-month clock restarted. Ids known only by
//      their ledger hash (a run-by-approval whose id the ERP no longer holds) are tombstoned by hash: the ledger hash
//      IS the tombstone hash, hex-encoded.
//   4. `forgetAtCollector` (separate call, made by the service LAST, just before the ledger row): forget mode:"erase"
//      for every plaintext id, at every collector website of the tenant.
//
// THE COLLECTOR IS UNREACHABLE DURING ERASE (the direction, and why). The ERP side commits regardless: deletion and
// tombstones are what stop ingest re-creating the person, and they must never wait on a remote. The forget is put on
// V3-e's retry queue (enqueueForget; flushed at the start of that property's next ingest or sweep), and the ledger
// records `collector_forget = 'queued'`, never 'delivered'. Three backstops bound what stays on the collector if the
// queue is lost (it is memory-only; plaintext ids are deliberately never written to the database): ingest re-sends an
// erase forget for any buffered event of an erase-tombstoned id; the browser's own /lib/kestrel/f; and the collector's
// 72 h buffer expiry. The forget runs inside the transaction (locks held, bounded by the client timeout) so the ledger
// row that commits states what actually happened; if the commit then failed after a delivered forget, the collector
// has erased data the approved request covered and the request can be re-run (forget is idempotent).
//
// NOTHING PERSONAL IN LOGS. Log lines carry property ids and typed outcomes only, never a visitor or consent id.
import type { PoolClient } from "pg";
import {
  InsightsError, forgetAtCollector, insightsSettings, type InsightsOpts,
} from "./insights-client";
import { VISITOR_LOCK_NS, enqueueForget } from "./visitor-jobs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_LOCK_WAIT_MS = 60_000;
const DEFAULT_LOCK_POLL_MS = 200;
const CLOSURE_ROUNDS = 4;

export type CollectorForgetStatus = "not_needed" | "delivered" | "queued" | "not_configured" | "id_not_held";
export type VisitorMatch = "visitor_id" | "consent_id" | "lead" | "linked";

export interface VisitorEraseDeps {
  insights?: InsightsOpts;
  /** How long to wait for the property locks (default 60 s). */
  lockWaitMs?: number;
  lockPollMs?: number;
}

let testDefaults: VisitorEraseDeps | null = null;
/** Tests: what the route-driven path uses (a fake collector, a short lock wait). null restores the env defaults. */
export function setVisitorEraseDepsForTests(d: VisitorEraseDeps | null): void { testDefaults = d; }
export function visitorEraseDeps(override?: VisitorEraseDeps): VisitorEraseDeps {
  return { ...(testDefaults ?? {}), ...(override ?? {}) };
}

/** The property locks stayed busy past the deadline. Thrown so the caller's transaction rolls back whole. */
export class VisitorStoreBusyError extends Error {
  constructor() {
    super("a visitor job holds a property of this company; nothing was changed, run the request again");
    this.name = "VisitorStoreBusyError";
  }
}

/** The seeds of a request's visitor scope. Every id lower-case; hashes hex. */
export interface VisitorSeeds {
  /** Given in the request (or rebuilt from its ledger hash). */
  visitorIds: string[];
  consentIds: string[];
  /** From the consent snapshot of each lead that matched the request's email/phone directly. */
  leadConsentIds: string[];
  /** Ledger hashes with no plaintext anywhere in the ERP (run-by-approval): tombstoned by hash, never forgotten by id. */
  visitorIdHashes: string[];
  consentIdHashes: string[];
}

export function emptySeeds(): VisitorSeeds {
  return { visitorIds: [], consentIds: [], leadConsentIds: [], visitorIdHashes: [], consentIdHashes: [] };
}

export function seedsAreEmpty(s: VisitorSeeds): boolean {
  return s.visitorIds.length + s.consentIds.length + s.leadConsentIds.length + s.visitorIdHashes.length + s.consentIdHashes.length === 0;
}

/** A lead's `visitor_consent` snapshot's consent id, when it is a well-formed uuid (lower-cased). */
export function leadConsentId(visitorConsent: unknown): string | null {
  if (visitorConsent === null || typeof visitorConsent !== "object" || Array.isArray(visitorConsent)) return null;
  const v = (visitorConsent as Record<string, unknown>).consentId;
  return typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Adds `search` to this transaction's declared module scope (app.scopes, SET LOCAL semantics). */
export async function declareSearchScope(c: PoolClient): Promise<void> {
  await c.query(
    `SELECT set_config('app.scopes', concat_ws(',', NULLIF(current_setting('app.scopes', true), ''), 'search'), true)`,
  );
}

/**
 * M5-G5b for visitor keys: the plaintext of an id known only by its ledger hash, from what this tenant still holds
 * (a profile's visitor or consent id; a lead's consent snapshot). null when nothing holds it any more. Declares the
 * search scope itself.
 */
export async function resolvePseudonyms(
  c: PoolClient, tenantId: string, hashes: { visitorIdHash: string | null; consentIdHash: string | null },
): Promise<{ visitorId: string | null; consentId: string | null }> {
  await declareSearchScope(c);
  let visitorId: string | null = null;
  let consentId: string | null = null;
  if (hashes.visitorIdHash && HASH_RE.test(hashes.visitorIdHash)) {
    const { rows } = await c.query<{ v: string }>(
      `SELECT visitor_id::text AS v FROM search_visitor_profiles
        WHERE tenant_id = $1 AND encode(sha256(convert_to(visitor_id::text, 'UTF8')), 'hex') = $2 LIMIT 1`,
      [tenantId, hashes.visitorIdHash],
    );
    visitorId = rows[0]?.v ?? null;
  }
  if (hashes.consentIdHash && HASH_RE.test(hashes.consentIdHash)) {
    const { rows } = await c.query<{ v: string }>(
      `SELECT v FROM (
         SELECT consent_id::text AS v FROM search_visitor_profiles WHERE tenant_id = $1
         UNION ALL
         SELECT lower(visitor_consent->>'consentId') FROM agency_leads
          WHERE tenant_id = $1 AND (visitor_consent->>'consentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       ) x
       WHERE encode(sha256(convert_to(v, 'UTF8')), 'hex') = $2 LIMIT 1`,
      [tenantId, hashes.consentIdHash],
    );
    consentId = rows[0]?.v ?? null;
  }
  return { visitorId, consentId };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════ matching
interface ProfileRow {
  id: string; property_id: string; domain: string | null; visitor_id: string; consent_id: string;
  first_seen_at: Date; last_seen_at: Date; visits: number; pageviews: number; device: string; country: string | null;
  city: string | null; first_source: unknown; network: unknown; company: unknown; interests: unknown; score: number;
  score_parts: unknown; created_at: Date; updated_at: Date; event_count: number;
}

interface Closure { profiles: ProfileRow[]; visitorIds: Set<string>; consentIds: Set<string> }

/** The profiles in scope, closed over shared ids (header). `forUpdate` locks them (erase). */
async function closeOverProfiles(c: PoolClient, tenantId: string, seeds: VisitorSeeds, forUpdate: boolean): Promise<Closure> {
  const visitorIds = new Set(seeds.visitorIds);
  const consentIds = new Set([...seeds.consentIds, ...seeds.leadConsentIds]);
  const byId = new Map<string, ProfileRow>();
  for (let round = 0; round < CLOSURE_ROUNDS; round++) {
    if (visitorIds.size + consentIds.size === 0) break;
    const { rows } = await c.query<ProfileRow>(
      `SELECT p.id, p.property_id::text AS property_id, sp.domain, p.visitor_id::text AS visitor_id, p.consent_id::text AS consent_id,
              p.first_seen_at, p.last_seen_at, p.visits, p.pageviews, p.device, p.country, p.city, p.first_source, p.network,
              p.company, p.interests, p.score, p.score_parts, p.created_at, p.updated_at,
              (SELECT count(*) FROM search_visitor_events e WHERE e.tenant_id = p.tenant_id AND e.profile_id = p.id)::int AS event_count
         FROM search_visitor_profiles p
         LEFT JOIN search_properties sp ON sp.id = p.property_id AND sp.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND (p.visitor_id = ANY($2::uuid[]) OR p.consent_id = ANY($3::uuid[]))
        ORDER BY p.property_id, p.first_seen_at, p.id
        ${forUpdate ? "FOR UPDATE OF p" : ""}`,
      [tenantId, [...visitorIds], [...consentIds]],
    );
    let grew = false;
    for (const r of rows) {
      byId.set(r.id, r);
      if (!visitorIds.has(r.visitor_id)) { visitorIds.add(r.visitor_id); grew = true; }
      if (!consentIds.has(r.consent_id)) { consentIds.add(r.consent_id); grew = true; }
    }
    if (!grew) break;
  }
  const profiles = [...byId.values()].sort((a, b) =>
    a.property_id.localeCompare(b.property_id) || new Date(a.first_seen_at).getTime() - new Date(b.first_seen_at).getTime() || a.id.localeCompare(b.id));
  return { profiles, visitorIds, consentIds };
}

function matchedBy(r: ProfileRow, seeds: VisitorSeeds): VisitorMatch[] {
  const out: VisitorMatch[] = [];
  if (seeds.visitorIds.includes(r.visitor_id)) out.push("visitor_id");
  if (seeds.consentIds.includes(r.consent_id)) out.push("consent_id");
  if (seeds.leadConsentIds.includes(r.consent_id)) out.push("lead");
  return out.length > 0 ? out : ["linked"];
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

// ═══════════════════════════════════════════════════════════════════════════════════════════ find / export
export interface FoundVisitorProfile {
  profileId: string;
  propertyId: string;
  /** Why it is in scope; "linked" = it shares an id with a profile that matched. */
  matchedBy: VisitorMatch[];
  firstSeenAt: string;
  lastSeenAt: string;
  visits: number;
  pageviews: number;
  eventCount: number;
}

export interface ExportedVisitorProfile extends FoundVisitorProfile {
  propertyDomain: string | null;
  visitorId: string;
  consentId: string;
  device: string;
  country: string | null;
  city: string | null;
  firstSource: unknown;
  network: unknown;
  company: unknown;
  interests: unknown;
  score: number;
  scoreParts: unknown;
  createdAt: string;
  updatedAt: string;
  events: { occurredAt: string; kind: string; path: string | null; name: string | null; data: unknown }[];
}

function found(r: ProfileRow, seeds: VisitorSeeds): FoundVisitorProfile {
  return {
    profileId: r.id, propertyId: r.property_id, matchedBy: matchedBy(r, seeds),
    firstSeenAt: iso(r.first_seen_at) as string, lastSeenAt: iso(r.last_seen_at) as string,
    visits: Number(r.visits), pageviews: Number(r.pageviews), eventCount: Number(r.event_count),
  };
}

/** find: what an erase would remove, without the ids themselves. */
export async function findVisitorProfiles(c: PoolClient, tenantId: string, seeds: VisitorSeeds): Promise<FoundVisitorProfile[]> {
  if (seeds.visitorIds.length + seeds.consentIds.length + seeds.leadConsentIds.length === 0) return [];
  await declareSearchScope(c);
  const { profiles } = await closeOverProfiles(c, tenantId, seeds, false);
  return profiles.map((r) => found(r, seeds));
}

/** export: every profile in scope with every one of its events (oldest first). */
export async function exportVisitorProfiles(c: PoolClient, tenantId: string, seeds: VisitorSeeds): Promise<ExportedVisitorProfile[]> {
  if (seeds.visitorIds.length + seeds.consentIds.length + seeds.leadConsentIds.length === 0) return [];
  await declareSearchScope(c);
  const { profiles } = await closeOverProfiles(c, tenantId, seeds, false);
  if (profiles.length === 0) return [];
  const ev = await c.query<{ profile_id: string; occurred_at: Date; kind: string; path: string | null; name: string | null; data: unknown }>(
    `SELECT profile_id, occurred_at, kind, path, name, data FROM search_visitor_events
      WHERE tenant_id = $1 AND profile_id = ANY($2::uuid[]) ORDER BY occurred_at ASC, collector_event_id ASC`,
    [tenantId, profiles.map((p) => p.id)],
  );
  return profiles.map((r) => ({
    ...found(r, seeds),
    propertyDomain: r.domain, visitorId: r.visitor_id, consentId: r.consent_id, device: r.device, country: r.country, city: r.city,
    firstSource: r.first_source, network: r.network, company: r.company, interests: r.interests, score: Number(r.score),
    scoreParts: r.score_parts, createdAt: iso(r.created_at) as string, updatedAt: iso(r.updated_at) as string,
    events: ev.rows.filter((e) => e.profile_id === r.id).map((e) => ({
      occurredAt: iso(e.occurred_at) as string, kind: e.kind, path: e.path, name: e.name, data: e.data,
    })),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════ erase
export interface VisitorEraseResult {
  profileCount: number;
  profileEventCount: number;
  tombstoneCount: number;
  collectorForget: CollectorForgetStatus;
  collectorForgetCalls: number;
  collectorDeletedEvents: number;
}

/** What the collector step needs; held in memory for the rest of the transaction only. */
export interface VisitorErasePlan {
  tenantId: string;
  /** Every property of the tenant with a collector website id: [propertyId, website]. */
  websites: Array<[string, string]>;
  visitorIds: string[];
  consentIds: string[];
  hashOnly: boolean;
  profileCount: number;
  profileEventCount: number;
  tombstoneCount: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Transaction-level V3-e property locks, in sorted order, polled with a deadline. */
async function lockProperties(c: PoolClient, propertyIds: string[], deps: VisitorEraseDeps): Promise<void> {
  const deadline = Date.now() + Math.max(0, deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  for (const id of [...propertyIds].sort()) {
    for (;;) {
      const r = await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1::int, hashtext($2::text)) AS ok`, [VISITOR_LOCK_NS, id]);
      if (r.rows[0]?.ok === true) break;
      const left = deadline - Date.now();
      if (left <= 0) throw new VisitorStoreBusyError();
      await sleep(Math.min(deps.lockPollMs ?? DEFAULT_LOCK_POLL_MS, left));
    }
  }
}

/**
 * Steps 1-3 of ERASE (header), on the caller's transaction: scope, locks, delete, tombstones. Returns the plan for
 * `forgetErasedAtCollector`. Seeds with nothing in them do nothing (no scope, no lock, no query).
 */
export async function eraseVisitorRows(c: PoolClient, tenantId: string, seeds: VisitorSeeds, deps: VisitorEraseDeps = {}): Promise<VisitorErasePlan> {
  const plan: VisitorErasePlan = {
    tenantId, websites: [], visitorIds: [], consentIds: [], hashOnly: false, profileCount: 0, profileEventCount: 0, tombstoneCount: 0,
  };
  if (seedsAreEmpty(seeds)) return plan;
  await declareSearchScope(c);
  const props = await c.query<{ id: string; website: string | null }>(
    `SELECT id::text AS id, umami_site_id AS website FROM search_properties WHERE tenant_id = $1 ORDER BY id`, [tenantId],
  );
  if (props.rows.length === 0) return plan; // no property: nothing can hold or ingest this person's visitor data
  await lockProperties(c, props.rows.map((p) => p.id), deps);

  const closure = await closeOverProfiles(c, tenantId, seeds, true);
  if (closure.profiles.length > 0) {
    const ids = closure.profiles.map((p) => p.id);
    plan.profileEventCount = closure.profiles.reduce((n, p) => n + Number(p.event_count), 0);
    const del = await c.query(`DELETE FROM search_visitor_profiles WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids]);
    plan.profileCount = del.rowCount ?? 0;
  }
  plan.visitorIds = [...closure.visitorIds].sort();
  plan.consentIds = [...closure.consentIds].sort();
  const visitorHashes = seeds.visitorIdHashes.filter((h) => HASH_RE.test(h));
  const consentHashes = seeds.consentIdHashes.filter((h) => HASH_RE.test(h));
  plan.hashOnly = visitorHashes.length + consentHashes.length > 0;

  // Both kinds, every property, reason 'erase'. A 'withdraw' tombstone is upgraded and its clock restarted.
  const t = await c.query(
    `INSERT INTO search_visitor_tombstones (tenant_id, property_id, kind, id_hash, reason)
     SELECT $1::uuid, p, k.kind, k.h, 'erase'
       FROM unnest($2::uuid[]) AS p
      CROSS JOIN (
        SELECT 'visitor'::text AS kind, sha256(convert_to(v::text, 'UTF8')) AS h FROM unnest($3::uuid[]) AS v
        UNION SELECT 'consent'::text, sha256(convert_to(k::text, 'UTF8')) FROM unnest($4::uuid[]) AS k
        UNION SELECT 'visitor'::text, decode(x, 'hex') FROM unnest($5::text[]) AS x
        UNION SELECT 'consent'::text, decode(x, 'hex') FROM unnest($6::text[]) AS x
      ) AS k
     ON CONFLICT (property_id, kind, id_hash) DO UPDATE SET reason = 'erase', created_at = now()
       WHERE search_visitor_tombstones.tenant_id = EXCLUDED.tenant_id`,
    [tenantId, props.rows.map((p) => p.id), plan.visitorIds, plan.consentIds, visitorHashes, consentHashes],
  );
  plan.tombstoneCount = t.rowCount ?? 0;
  plan.websites = props.rows.filter((p) => typeof p.website === "string" && UUID_RE.test(p.website)).map((p) => [p.id, (p.website as string).toLowerCase()]);
  return plan;
}

/**
 * Step 4: forget mode:"erase" at every collector website of the tenant. Never throws for a collector failure: the ids
 * are queued for retry and the status says 'queued'. Logs property ids and the typed failure only.
 */
export async function forgetErasedAtCollector(plan: VisitorErasePlan, deps: VisitorEraseDeps = {}): Promise<VisitorEraseResult> {
  const out: VisitorEraseResult = {
    profileCount: plan.profileCount, profileEventCount: plan.profileEventCount, tombstoneCount: plan.tombstoneCount,
    collectorForget: "not_needed", collectorForgetCalls: 0, collectorDeletedEvents: 0,
  };
  const ids = plan.visitorIds.length + plan.consentIds.length;
  if (plan.websites.length === 0 || (ids === 0 && !plan.hashOnly)) return out;
  const settings = deps.insights?.settings === undefined ? insightsSettings() : deps.insights.settings;
  if (!settings) { out.collectorForget = "not_configured"; return out; }
  let queued = false;
  if (ids > 0) {
    for (const [propertyId, website] of plan.websites) {
      try {
        const r = await forgetAtCollector(website, { visitorIds: plan.visitorIds, consentIds: plan.consentIds }, "erase", { ...deps.insights, settings });
        out.collectorForgetCalls += r.calls;
        out.collectorDeletedEvents += r.deleted.events ?? 0;
      } catch (err) {
        queued = true;
        enqueueForget(propertyId, website, "erase", plan.visitorIds, plan.consentIds);
        const kind = err instanceof InsightsError ? err.kind : "error";
        console.error(`[AGENCY-PRIVACY] erase: collector forget for property ${propertyId} queued for retry (${kind})`);
      }
    }
  }
  out.collectorForget = queued ? "queued" : plan.hashOnly ? "id_not_held" : "delivered";
  return out;
}
