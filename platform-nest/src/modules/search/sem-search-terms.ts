// SM-20 — search-terms sync (design §12 SM-20: "Ads-Scripts read bridge: exporter template + signed
// n8n webhook -> metrics-daily + search terms"; tracker row: "Simulated script POST ingests
// idempotently (UNIQUE day upsert); tampered signature refused"). THIS ticket is scoped to the
// search-terms half only (see file header on migration 0062) — the campaign-level metrics-daily
// bridge into `search_campaign_metrics_daily` (0034) is a separate, not-yet-built ingest and is
// deliberately untouched here.
//
// Pure, synchronous, no I/O — the same split every sibling sub-module in this directory uses
// (search-audit.ts, sem-plan.ts, sem-export.ts): search.controller.ts owns every DB read/write and
// the shared-secret check; this file only (a) validates a raw webhook body into a typed, bounded
// batch, (b) computes the idempotency hash, and (c) exposes the two scope-match predicates the
// controller's SM-63-class admission check calls.
//
// ── WHY THIS IS NOT A PAID PULL (design addendum §A11/§A12, transposed) ────────────────────────────
// No vendor is dispatched to produce this data. A client's own Google Ads Script — an exporter
// template this platform generates, seeded with OUR internal engagement/campaign ids at generation
// time (the same "our own ids travel with the artifact" convention sem-export.ts's Ads-Editor CSVs
// already use) — runs INSIDE their Ads account and POSTs its own account's search-term report to us.
// There is no vendor dollar of ours to meter: this module never calls `dispatchProviderOp` for this
// edge, writes no `search_provider_calls` row, and no column here points at that ledger. `cost_minor`
// carried on an ingested row is the CLIENT's own real Google Ads spend, self-reported by their
// account — a fundamentally different figure from anything this module meters for ITSELF, and per
// design addendum §A3's money-language rule it must never be summed with `search_provider_calls.
// cost_usd` or rendered as though it were our cost-to-serve. See migration 0062's column comment on
// `search_term_metrics_daily.cost_minor`.
//
// ── THE ADMISSION CHECK IS TWO-LEVEL, BOTH SM-63's CLASS ────────────────────────────────────────────
// This webhook is authenticated by ONE shared secret (no per-tenant, per-engagement, or per-campaign
// credential — see search.controller.ts's `assertSemCallbackSecret`), so the ONLY thing standing
// between "a caller who merely holds the secret" and "attaching data to a client relationship that
// never authorized it" (this ticket's hazard 1, the exact shape SM-56's collect edge got wrong before
// SM-63 fixed it, tracker §6bb) is resolving every id the payload carries against the tenant's OWN
// records and refusing on ANY mismatch — never trusting the payload's claim about its own scope:
//   1. campaignScopeMatches — the campaign id in the payload must resolve (within THIS tenant, via
//      the caller's own RLS-scoped connection) to a campaign whose OWN engagement_id equals the
//      engagementId the payload ALSO claims. A payload naming a real campaignId under a DIFFERENT
//      engagement than it claims is refused, not silently attributed to the claimed engagement.
//   2. adGroupScopeMatches — same shape one level down: every ad_group_id referenced by a row must
//      resolve to an ad group whose OWN campaign_id equals the campaign this batch is FOR. An ad
//      group borrowed from a different campaign (same tenant, same or different engagement) is
//      refused for the same reason.
// Both predicates return a bare boolean, deliberately (never a message distinguishing "wrong scope"
// from "does not exist") — the controller maps EVERY admission failure to the SAME 404 with the SAME
// message via `SearchTermScopeError`, so this edge cannot become an oracle for enumerating another
// engagement's or campaign's ids (SM-56/SM-63's own stated reasoning, §6bb, applied verbatim here).
//
// ── IDEMPOTENCY: SEE MIGRATION 0062'S FILE HEADER for the hash-vs-tuple decision (SM-08's hash
// precedent, chosen over a direct tuple UNIQUE because `term` is unbounded caller text — the exact
// axis the ticket asked this decision to be made on, explicitly). `computeSearchTermRowHash` below is
// the ONLY place that hash is computed; the UNIQUE (tenant_id, campaign_id, row_hash) constraint plus
// the controller's `INSERT ... ON CONFLICT ... DO UPDATE` is what makes a redelivered or partially-
// overlapping batch resolve to one row per tuple, atomically, under real concurrency — never an
// application check-then-insert window. `INGEST_RACE_DELAY_MS` below exists ONLY so the test suite
// can widen that window on demand and prove the guarantee under a genuinely forced race rather than a
// hopeful `Promise.all` that might never actually collide on fast local hardware (the §6ay lesson this
// ticket's own instructions cite) — production code always runs with it at its default of 0.
import { createHash } from "node:crypto";

export const MATCH_TYPES = ["broad", "phrase", "exact", "none"] as const;
export type MatchType = (typeof MATCH_TYPES)[number];
const MATCH_TYPE_SET = new Set<string>(MATCH_TYPES);

// Hostile-input guards (design addendum §A14 hazard: a hostile/oversized payload must 400, never 500
// or a partial write — checked here, BEFORE any DB connection is even opened, same discipline as
// search-audit.ts's validateCrawlerReport / MAX_REPORT_PAGES).
export const MAX_ROWS_PER_BATCH = 2_000; // generous headroom for one campaign-day script export
export const MAX_TERM_LENGTH = 500; // Google's own UI truncates search terms well under this

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RawSearchTermRow {
  adGroupId?: unknown;
  date?: unknown;
  term?: unknown;
  matchType?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  costMinor?: unknown;
  currency?: unknown;
  conversions?: unknown;
  convValueMinor?: unknown;
}

export interface RawSearchTermBatch {
  engagementId?: unknown;
  campaignId?: unknown;
  rows?: unknown;
}

export interface ValidatedSearchTermRow {
  adGroupId: string;
  date: string;
  term: string;
  matchType: MatchType;
  impressions: number;
  clicks: number;
  costMinor: number;
  currency: string | null;
  conversions: number;
  convValueMinor: number;
}

export interface ValidatedSearchTermBatch {
  engagementId: string;
  campaignId: string;
  rows: ValidatedSearchTermRow[];
}

function isNonNegFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Validates a raw webhook body into a typed, bounded batch. Throws a plain Error with a
 *  human-readable reason on any structural problem — the caller (search.controller.ts) wraps this in
 *  a BadRequestException, so hostile input is always a 400, never a 500 or a partial write
 *  (validation runs fully BEFORE any DB read or transaction starts — SM-08's own discipline, cited
 *  by this ticket's own instructions). Does NOT check UUID format for engagementId/campaignId/
 *  adGroupId — the controller's existing `assertUuid` does that, same convention every other body-
 *  supplied id in this controller already follows (see rankPullCallback). */
export function validateSearchTermBatch(body: unknown): ValidatedSearchTermBatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("body must be a JSON object");
  }
  const b = body as RawSearchTermBatch;
  if (typeof b.engagementId !== "string" || !b.engagementId) throw new Error("engagementId must be a non-empty string");
  if (typeof b.campaignId !== "string" || !b.campaignId) throw new Error("campaignId must be a non-empty string");
  if (!Array.isArray(b.rows)) throw new Error("rows must be an array");
  if (b.rows.length === 0) throw new Error("rows must not be empty");
  if (b.rows.length > MAX_ROWS_PER_BATCH) throw new Error(`rows exceeds the ${MAX_ROWS_PER_BATCH}-row ingest limit`);

  const rows: ValidatedSearchTermRow[] = (b.rows as unknown[]).map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`rows[${i}] must be an object`);
    const r = raw as RawSearchTermRow;
    if (typeof r.adGroupId !== "string" || !r.adGroupId) throw new Error(`rows[${i}].adGroupId must be a non-empty string`);
    if (typeof r.date !== "string" || !DATE_RE.test(r.date)) throw new Error(`rows[${i}].date must be a YYYY-MM-DD string`);
    if (typeof r.term !== "string" || !r.term) throw new Error(`rows[${i}].term must be a non-empty string`);
    if (r.term.length > MAX_TERM_LENGTH) throw new Error(`rows[${i}].term exceeds the ${MAX_TERM_LENGTH}-character ingest limit`);
    let matchType: MatchType = "none";
    if (r.matchType !== undefined) {
      if (typeof r.matchType !== "string" || !MATCH_TYPE_SET.has(r.matchType)) {
        throw new Error(`rows[${i}].matchType must be one of ${MATCH_TYPES.join("|")}`);
      }
      matchType = r.matchType as MatchType;
    }
    if (r.impressions !== undefined && !isNonNegFinite(r.impressions)) throw new Error(`rows[${i}].impressions must be a non-negative number`);
    if (r.clicks !== undefined && !isNonNegFinite(r.clicks)) throw new Error(`rows[${i}].clicks must be a non-negative number`);
    if (r.costMinor !== undefined && !isNonNegFinite(r.costMinor)) throw new Error(`rows[${i}].costMinor must be a non-negative number`);
    if (r.conversions !== undefined && !isNonNegFinite(r.conversions)) throw new Error(`rows[${i}].conversions must be a non-negative number`);
    if (r.convValueMinor !== undefined && !isNonNegFinite(r.convValueMinor)) throw new Error(`rows[${i}].convValueMinor must be a non-negative number`);
    if (r.currency !== undefined && typeof r.currency !== "string") throw new Error(`rows[${i}].currency must be a string`);
    return {
      adGroupId: r.adGroupId,
      date: r.date,
      term: r.term,
      matchType,
      impressions: (r.impressions as number | undefined) ?? 0,
      clicks: (r.clicks as number | undefined) ?? 0,
      costMinor: (r.costMinor as number | undefined) ?? 0,
      currency: (r.currency as string | undefined) ?? null,
      conversions: (r.conversions as number | undefined) ?? 0,
      convValueMinor: (r.convValueMinor as number | undefined) ?? 0,
    };
  });

  return { engagementId: b.engagementId, campaignId: b.campaignId, rows };
}

/** THE idempotency key (see file header + migration 0062). Pipe-delimited sha256 hex over the
 *  canonical tuple — same shape as google/gsc-client.ts's gscRowHash, deliberately, for the same
 *  reason: a stable, fixed-width key over a tuple whose text member (`term`) is unbounded. */
export function computeSearchTermRowHash(campaignId: string, adGroupId: string, date: string, term: string, matchType: string): string {
  return createHash("sha256").update(`${campaignId}|${adGroupId}|${date}|${term}|${matchType}`).digest("hex");
}

/** SM-63's class, level 1: the resolved campaign's OWN engagement_id vs. what the payload claims.
 *  Bare boolean, deliberately (see file header) — the controller decides the refusal shape. */
export function campaignScopeMatches(campaign: { engagementId: string }, claimedEngagementId: string): boolean {
  return campaign.engagementId === claimedEngagementId;
}

/** SM-63's class, level 2: the resolved ad group's OWN campaign_id vs. the campaign this batch is
 *  FOR. Bare boolean, same reasoning. */
export function adGroupScopeMatches(adGroup: { campaignId: string }, expectedCampaignId: string): boolean {
  return adGroup.campaignId === expectedCampaignId;
}

/** ONE error, reused for every admission failure this edge can produce (campaign not found,
 *  engagement mismatch, ad group not found, ad group/campaign mismatch) — same message, same shape,
 *  so the edge cannot be used to distinguish "doesn't exist" from "exists but is not yours" (SM-56/
 *  SM-63's own stated reasoning, tracker §6bb, applied verbatim). The controller maps this to a 404. */
export class SearchTermScopeError extends Error {
  constructor() {
    super("no such campaign for this engagement");
    this.name = "SearchTermScopeError";
  }
}

// ── TEST-ONLY instrumentation ─────────────────────────────────────────────────────────────────────
// Widens the window between the controller's admission/scope reads and the actual upsert write, so a
// test can force two (or more) concurrent requests to genuinely overlap at the database rather than
// hoping `Promise.all` happens to collide on whatever hardware CI runs on (the §6ay lesson: a
// concurrent test that never actually collides passes while proving nothing). ALWAYS 0 in production
// — nothing outside the test suite ever sets this above 0, and the controller reads it fresh on every
// request rather than capturing it at import time so a test can flip it per-case.
export let INGEST_RACE_DELAY_MS = 0;
export function __setIngestRaceDelayMsForTests(ms: number): void {
  INGEST_RACE_DELAY_MS = ms;
}
