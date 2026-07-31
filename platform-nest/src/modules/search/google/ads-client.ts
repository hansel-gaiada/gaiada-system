// SM-25c — Google Ads READ binding: response INTERPRETATION + persistence (design addendum §A12;
// tracker §6x.3 item 5's "SM-25c · Ads read binding"). api-client.ts's `adsSearch` (SM-25a) already
// hands back a parsed JSON envelope over an authorized, refresh-on-401, quota-bounded socket, with
// its `assertReadOnlyPath` guard structurally refusing any mutate-shaped path — this file's job
// starts there: turning a GAQL `googleAds:search` response into rows worth keeping, keeping them
// exactly once, and doing so on the THIRD egress class (§A12.1: client-private, $0, per-client OAuth
// — no dispatchProviderOp, no search_provider_calls, no search_data_cache, ever). Mirrors
// gsc-client.ts/ga4-client.ts's shape (resolve → dispatch/fetch → persist → return an outcome the
// controller echoes) exactly; every deviation below is called out against that precedent.
//
// ── ADS WRITES ARE OUT OF SCOPE, STRUCTURALLY, NOT BY CONVENTION ──────────────────────────────────
// Every Ads mutation stays under SM-21's approve-execute-replay + WS4 one-shot approval regardless of
// transport (§A12.1/D-8) — `adsSearch` cannot even reach a mutate path (api-client.ts's
// `assertReadOnlyPath`), so there is nothing for this file to guard against re-inventing.
//
// ── THE ACCOUNT LINK: WHY A SEPARATE STEP FROM THE CONNECTION ITSELF ──────────────────────────────
// GSC/GA4 identify "which property" via `search_properties.{gsc,ga4}_connection_id` — a connection
// IS the property binding. Ads needs one MORE fact the OAuth grant itself never carries: WHICH Ads
// customer (account) under that Google login to query. A Google login can see many Ads accounts (an
// MCC manager account structure), so `linkAdsCustomerId` below records that choice on the
// connection's own `external_account` column (core's `patchConnection`, already exported for exactly
// this decision #8 use) — the SAME column GSC/GA4 leave null (they have no equivalent ambiguity).
// This is deliberately a SEPARATE call from `startAuthorization`/`completeAuthorization` (oauth.ts):
// the OAuth grant can complete before an operator has decided which child account to track, and
// forcing the two into one step would block the whole link on a fact OAuth cannot supply.
//
// ── WHY THIS TABLE, NOT A NEW ONE ──────────────────────────────────────────────────────────────────
// `search_campaign_metrics_daily` (0034) already exists for SM-20's Ads-Scripts/CSV bridge, keyed
// `UNIQUE (campaign_id, date)` — exactly the grain an Ads read pull produces (campaign x day), and
// exactly the "read pulls into the SM-20 tables (same idempotent UNIQUE-day upserts)" the ticket
// names. Writing a second table for the identical grain and a different `source` value would fork a
// figure ("campaign spend/clicks for this day") that every pacing/rollup reader needs to be ONE
// number regardless of which pipe wrote it — 0064 additively widens this table with the provenance
// this module's standing rule requires (`simulated`, `connection_id`), rather than forking it.
//
// ── ECHO-VALIDATION (§A14; §6bi's discriminator) — EVERY ROW IS INDEPENDENTLY ADDRESSED ───────────
// Unlike DFS's `postSerpTasks` (§6bi: one posted keyword paired POSITIONALLY to one response slot, so
// a pairing break impeaches the whole tail), a GAQL `search` response is a flat, self-describing row
// set: each row carries its OWN `customer.id` / `campaign.id` / `segments.date`, independently of
// every other row. There is also NO vendor charge on this path (§A12.1: Ads reads cost us nothing) —
// so §A14.5's money-recording split (record the charge, refuse the data) does not apply here at all;
// there is no charge to record. Every echo violation below is therefore squarely the §A14.2 DATA
// disposition — skip the ONE offending row, count it, disclose the count, keep the rest of the pull —
// never a whole-response refusal:
//   * `customer.id` must canonically match the customerId THIS call queried for (rowsWrongCustomerSkipped)
//   * `segments.date` must fall in `[startDate, effectiveEndDate]` (rowsOutsideRangeSkipped, reusing
//     freshness.ts's `isRowDateWithinWindow` — the identical shared predicate GSC/GA4 already use)
//   * `campaign.id` must resolve to a campaign THIS engagement already tracks (rowsUnmatchedCampaignSkipped)
//   * a structurally incomplete row (no campaign id, no date) is `malformedRowsSkipped`, same as GSC/GA4
// Absent echo (`customer.id` genuinely missing from a row) is NO signal, not a mismatch — accepted,
// per §A14.5's "absent echo is no signal" clause, transposed from the identity axis to this data axis.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { patchConnection } from "../../../core/integrations.service";
import { adsSearch } from "./api-client";
import type { FetchImpl } from "./token-endpoint-client";
import {
  GoogleAdsCustomerNotLinkedError, GoogleAdsNotConfiguredError, GoogleConnectionNotLinkedError, GooglePropertyNotBoundError,
} from "./errors";
import { getGoogleConnection, resolvePropertyConnection, type GoogleConnectionView } from "./oauth";
import { clampEndDateToFreshnessLag, isoDateDaysAgo, isRowDateWithinWindow } from "./freshness";

// ── policy defaults (local consts, NOT config.ts — same file-ownership note gsc-client.ts states:
// config.ts already carries every Ads-specific SEAM this ticket needs — base URL, developer token,
// login-customer-id, API version — see config.ts's own "SM-25c's own AC" comment on the developer
// token. Only POLICY constants (lag days, window, page size) live here, exactly like GSC_/GA4_'s own
// module-local constants.) ──────────────────────────────────────────────────────────────────────────

/** Google Ads reporting is documented to settle same-day figures throughout the day (click/impression
 *  counts, fraud-filtering adjustments); this is deliberately non-zero for the identical reason
 *  GSC_FRESHNESS_LAG_DAYS/GA4_FRESHNESS_LAG_DAYS are non-zero — a "today" pull would otherwise persist
 *  a genuinely partial day that later corrects, misreading as a spend/click collapse. UNVERIFIED
 *  against a real account (SM-41G) — the conservative documented figure, not an observed one. */
export const ADS_FRESHNESS_LAG_DAYS = 1;

const ADS_DEFAULT_WINDOW_DAYS = 7;

/** Google Ads' own documented ceiling on `pageSize` for GoogleAdsService.Search. Never exceeded even
 *  if a caller asks for more — a vendor ceiling, not a policy choice (GSC_MAX_ROW_LIMIT's own shape). */
export const ADS_MAX_PAGE_SIZE = 10000;

/** The default per-request page size this module actually uses — bounded well below the vendor
 *  ceiling because the common case (a handful of tracked campaigns x a week of days) needs far less,
 *  and a smaller default keeps a single pull's parse/upsert cost bounded (GSC_DEFAULT_ROW_LIMIT's own
 *  reasoning, transposed). */
export const ADS_DEFAULT_PAGE_SIZE = 1000;

/** Safety cap on PAGES fetched per pull call — GSC_DEFAULT_MAX_PAGES's own reasoning: bounds the
 *  worst case (an unusually wide date range across many tracked campaigns) to a fixed number of round
 *  trips rather than an unbounded loop. Hitting the cap while the last page was still full sets
 *  `truncated: true` rather than silently under-reporting. */
export const ADS_DEFAULT_MAX_PAGES = 4;

const DIGITS_RE = /^\d+$/;

/** Strip everything but digits — Google conventionally DISPLAYS a customer id dashed ("123-456-7890")
 *  but the API path segment and every internal comparison want the bare digit string. Exported so the
 *  controller can normalize a body-supplied override the identical way a linked connection's own
 *  stored value already is. */
export function normalizeAdsCustomerId(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

/** §A14.5's canonicalization rule (trim + NFC + lowercase + collapse whitespace), transposed onto
 *  Ads' pure-digit ids. Ads ids never carry case or internal whitespace, so this reduces to a trim in
 *  practice — implemented as the full named shape anyway (not `.trim()` inlined at each call site)
 *  because §6bi's own text asks for exactly that: "the next echo-bearing driver reuses it." Kept
 *  LOCAL to this module rather than imported from providers/dataforseo.ts's `canonicalizeEchoValue`:
 *  that file is the shared-vendor MONEY path (§A12.1's own boundary), and importing a helper across
 *  that boundary would entangle two egress classes design deliberately keeps apart, for the sake of
 *  one line. */
function canonicalizeAdsId(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

function microsToMinor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  // 1 000 000 micros = 1 currency unit = 100 minor units (cents) ⇒ 1 minor unit = 10 000 micros.
  return Math.round(n / 10000);
}

/** `metrics.conversions_value` is documented as a plain currency-unit float (NOT micros — only the
 *  `*_micros` fields are), so this is a straight x100 to minor units, distinct from `microsToMinor`. */
function currencyUnitsToMinor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function numberOr0(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** THE canonical Ads Search row shape this file depends on (docs-authored, §A12.3's own honesty
 *  disclaimer applies — SM-41G confirms against a real account). Money arrives as a STRING in micros
 *  (ads-search.ts fixture's own documented shape); every resource is nested by NAME, mirroring the
 *  GAQL SELECT clause. */
interface AdsSearchResult {
  customer?: { id?: string; currency_code?: string };
  campaign?: { id?: string; name?: string };
  segments?: { date?: string };
  metrics?: {
    impressions?: string; clicks?: string; cost_micros?: string; conversions?: string; conversions_value?: string;
  };
}
interface AdsSearchResponse {
  results?: AdsSearchResult[];
  nextPageToken?: string;
  fieldMask?: string;
}

/** One bounded, ordered GAQL query for exactly the campaigns this engagement tracks — never an
 *  account-wide query. `externalCampaignIds` is pre-filtered to `DIGITS_RE`-clean strings by the
 *  caller (see `pullAdsMetricsForEngagement`), so string-interpolating them into the `IN (...)` clause
 *  is safe: nothing that ever reaches this function has passed anything but that regex. */
function buildAdsMetricsQuery(externalCampaignIds: string[], startDate: string, endDate: string): string {
  return (
    "SELECT customer.id, customer.currency_code, campaign.id, campaign.name, segments.date, " +
    "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value " +
    "FROM campaign " +
    `WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ` +
    `AND campaign.id IN (${externalCampaignIds.join(",")}) ` +
    "ORDER BY campaign.id, segments.date"
  );
}

// ── 1 · THE ACCOUNT LINK ────────────────────────────────────────────────────────────────────────────

/** Set (or change) the Ads customer id an Ads connection queries. Validates the connection actually
 *  IS a `google_ads` connection first — `patchConnection` itself has no provider concept (it is
 *  core's generic mapping-metadata PATCH), so this is the ONE place that guard belongs. Returns the
 *  refreshed MASKED view (never re-derives it from `patchConnection`'s own return, which is core's
 *  `ConnectionResponse` shape, not this module's `GoogleConnectionView` — re-reading through
 *  `getGoogleConnection` keeps exactly one definition of that mapping, oauth.ts's own). */
export async function linkAdsCustomerId(
  tenantId: string,
  connectionId: string,
  rawCustomerId: string,
): Promise<GoogleConnectionView> {
  const customerId = normalizeAdsCustomerId(rawCustomerId);
  if (!customerId) throw new Error("customerId must contain at least one digit");
  const connection = await getGoogleConnection(tenantId, connectionId);
  if (!connection) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  if (connection.provider !== "google_ads") {
    throw new Error(`connection ${connectionId} is a ${connection.provider} connection, not google_ads`);
  }
  await patchConnection(tenantId, connectionId, { externalAccount: customerId });
  const refreshed = await getGoogleConnection(tenantId, connectionId);
  if (!refreshed) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  return refreshed;
}

// ── 2 · THE PULL ─────────────────────────────────────────────────────────────────────────────────

export interface PullAdsMetricsParams {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  /** Digits (dashes tolerated, stripped) — omit to use the connection's OWN linked customer id
   *  (`linkAdsCustomerId`). An explicit override exists for a one-off pull against a different child
   *  account under the same MCC login without permanently relinking the connection. */
  customerId?: string;
  endDate?: string;
  startDate?: string;
  pageSize?: number;
  maxPages?: number;
  fetchImpl?: FetchImpl;
}

export interface AdsPullOutcome {
  engagementId: string;
  status: "pulled";
  customerId: string;
  startDate: string;
  requestedEndDate: string;
  effectiveEndDate: string;
  clampedForFreshness: boolean;
  freshnessLagDays: number;
  /** How many of this engagement's `search_campaigns` rows carry a `platform='google_ads'` external
   *  id at all — the query is bounded to exactly these, never account-wide (§A12.1's quota-is-the-
   *  bound doctrine). Zero is an honest, common, non-error outcome (nothing tracked yet). */
  campaignsTracked: number;
  /** A tracked campaign whose `external_id` is not a clean digit string — never interpolated into the
   *  GAQL query (a defensive echo-validation-adjacent guard: `external_id` is caller-set data via a
   *  route this ticket does not own, so it is validated here rather than trusted). */
  campaignsWithInvalidExternalIdSkipped: number;
  rowsUpserted: number;
  malformedRowsSkipped: number;
  /** SM-64-class echo-validation (§A14, axis: date window) — a returned row's OWN `segments.date`
   *  fell outside `[startDate, effectiveEndDate]`. Skipped before the UPSERT, counted, never silently
   *  absorbed. */
  rowsOutsideRangeSkipped: number;
  /** §A14, axis: customer identity — a returned row's OWN `customer.id` did not canonically match the
   *  customerId THIS call queried for. A DATA-axis skip (§6bi's discriminator: each row is
   *  independently addressed, never positionally paired), not a whole-pull refusal. */
  rowsWrongCustomerSkipped: number;
  /** §A14, axis: campaign identity — a returned row's `campaign.id` did not resolve to one of this
   *  engagement's OWN tracked campaigns. */
  rowsUnmatchedCampaignSkipped: number;
  pagesFetched: number;
  truncated: boolean;
  provider: "google_ads";
  connectionId: string;
  simulated: boolean;
}

/** Pull + persist Google Ads campaign-day metrics for one engagement's TRACKED campaigns, over one
 *  explicit date range — the unit search.controller-adjacent `POST engagements/:id/ads-pull` calls
 *  (this ticket's own controller — see search-google-ads.controller.ts). NOT wired into any scheduler
 *  (the ticket's "flows own zero routes" framing, identical to gsc-client.ts/ga4-client.ts). */
export async function pullAdsMetricsForEngagement(p: PullAdsMetricsParams): Promise<AdsPullOutcome> {
  // FAIL-CLOSED before any I/O: no Ads call may even be attempted without an approved developer token
  // (config.ts's own stated AC for this ticket).
  if (!config.search.google.adsDeveloperToken) throw new GoogleAdsNotConfiguredError();

  const connectionId = await resolvePropertyConnection(p.tenantId, p.propertyId, "google_ads");
  if (!connectionId) throw new GooglePropertyNotBoundError(p.propertyId, "google_ads");
  const connection = await getGoogleConnection(p.tenantId, connectionId);
  if (!connection) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  // Defensive: `bindGooglePropertyConnection` (search.controller.ts, not this ticket's to edit)
  // resolves a connectionId through the tenant+client cross-check but does not itself pin the
  // connection's OWN `.provider` against the binding column it is being written into — so a
  // wrong-provider connection bound onto `ads_connection_id` by mistake is a real, if narrow,
  // upstream gap. Guarded here rather than silently trusted, since this file is what would otherwise
  // send that connection's Bearer token to the Ads surface.
  if (connection.provider !== "google_ads") throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  const simulated = !connection.issuerIsGoogle;

  const customerId = normalizeAdsCustomerId(p.customerId ?? connection.externalAccount ?? "");
  if (!customerId) throw new GoogleAdsCustomerNotLinkedError(connectionId);

  const clamp = clampEndDateToFreshnessLag(p.endDate, ADS_FRESHNESS_LAG_DAYS);
  const startDate = p.startDate ?? isoDateDaysAgo(ADS_FRESHNESS_LAG_DAYS + ADS_DEFAULT_WINDOW_DAYS - 1);
  const pageSize = Math.min(Math.max(1, p.pageSize ?? ADS_DEFAULT_PAGE_SIZE), ADS_MAX_PAGE_SIZE);
  const maxPages = Math.max(1, p.maxPages ?? ADS_DEFAULT_MAX_PAGES);

  const tracked = await withTenants(
    [p.tenantId],
    (c) =>
      c.query<{ id: string; external_id: string | null }>(
        `SELECT id, external_id FROM search_campaigns
          WHERE engagement_id = $1 AND platform = 'google_ads' AND external_id IS NOT NULL
            AND deleted_at IS NULL`,
        [p.engagementId],
      ),
    { modules: ["search"] },
  );
  const byExternalId = new Map<string, string>(); // normalized external_id -> our own campaign uuid
  let campaignsWithInvalidExternalIdSkipped = 0;
  for (const row of tracked.rows) {
    const ext = (row.external_id ?? "").trim();
    if (DIGITS_RE.test(ext)) byExternalId.set(ext, row.id);
    else campaignsWithInvalidExternalIdSkipped++;
  }
  const campaignsTracked = byExternalId.size;

  const emptyOutcome = (): AdsPullOutcome => ({
    engagementId: p.engagementId, status: "pulled", customerId,
    startDate, requestedEndDate: clamp.requestedEndDate, effectiveEndDate: clamp.effectiveEndDate,
    clampedForFreshness: clamp.clamped, freshnessLagDays: ADS_FRESHNESS_LAG_DAYS,
    campaignsTracked, campaignsWithInvalidExternalIdSkipped,
    rowsUpserted: 0, malformedRowsSkipped: 0, rowsOutsideRangeSkipped: 0,
    rowsWrongCustomerSkipped: 0, rowsUnmatchedCampaignSkipped: 0,
    pagesFetched: 0, truncated: false,
    provider: "google_ads", connectionId, simulated,
  });

  // Nothing tracked ⇒ nothing to query. An honest, common, non-error outcome (§A12's "empty is not
  // zero" doctrine transposed to a WRITE path: this reports "nothing linked", never a fabricated
  // pull) — never spends a network round trip on an account-wide query nobody asked for.
  if (campaignsTracked === 0) return emptyOutcome();

  const externalIds = [...byExternalId.keys()];
  let pagesFetched = 0;
  let truncated = false;
  let pageToken: string | undefined;
  const parsedRows: Array<{
    campaignId: string; date: string; impressions: number; clicks: number; costMinor: number;
    currency: string | null; conversions: number; convValueMinor: number;
  }> = [];
  let malformedRowsSkipped = 0;
  let rowsOutsideRangeSkipped = 0;
  let rowsWrongCustomerSkipped = 0;
  let rowsUnmatchedCampaignSkipped = 0;

  for (let page = 0; page < maxPages; page++) {
    const res = await adsSearch<AdsSearchResponse>({
      tenantId: p.tenantId, connectionId, customerId,
      query: buildAdsMetricsQuery(externalIds, startDate, clamp.effectiveEndDate),
      pageSize, pageToken, fetchImpl: p.fetchImpl,
    });
    pagesFetched++;
    const rawResults = res.data.results ?? []; // ABSENT (not []) is Google's own "no data" shape
    // SM-64-class echo (§A14, axis: pageSize echo) — an over-full page is sliced BEFORE the parse
    // loop, never parsed/persisted whole: persist what was asked for, not everything the vendor sent.
    // Same reasoning as gsc-client.ts's identical guard: offsets/tokens past an over-full page are
    // not trustworthy, so paging stops here.
    const overLimit = rawResults.length > pageSize;
    const results = overLimit ? rawResults.slice(0, pageSize) : rawResults;
    if (overLimit) truncated = true;

    for (const r of results) {
      const rawCampaignId = r.campaign?.id;
      const rawDate = r.segments?.date;
      if (!rawCampaignId || !rawDate) {
        malformedRowsSkipped++; // a row with no campaign id or no date is not a fact worth guessing at
        continue;
      }
      const rawCustomerId = r.customer?.id;
      // Absent echo is NO signal, not a mismatch (§A14.5) — only a PRESENT, canonically-different
      // customer.id counts as a violation.
      if (rawCustomerId !== undefined && canonicalizeAdsId(rawCustomerId) !== canonicalizeAdsId(customerId)) {
        rowsWrongCustomerSkipped++;
        continue;
      }
      if (!isRowDateWithinWindow(rawDate, startDate, clamp.effectiveEndDate)) {
        rowsOutsideRangeSkipped++;
        continue;
      }
      const localCampaignId = byExternalId.get(canonicalizeAdsId(rawCampaignId));
      if (!localCampaignId) {
        rowsUnmatchedCampaignSkipped++; // a real Ads campaign this engagement does not track — never persisted
        continue;
      }
      parsedRows.push({
        campaignId: localCampaignId, date: rawDate,
        impressions: numberOr0(r.metrics?.impressions), clicks: numberOr0(r.metrics?.clicks),
        costMinor: microsToMinor(r.metrics?.cost_micros),
        currency: r.customer?.currency_code ?? null,
        conversions: numberOr0(r.metrics?.conversions),
        convValueMinor: currencyUnitsToMinor(r.metrics?.conversions_value),
      });
    }

    if (overLimit) break; // stop paging — offsets past an over-full page are meaningless
    if (!res.data.nextPageToken) break; // Google's own "last page" signal — absence, not an empty array
    if (page === maxPages - 1) { truncated = true; break; } // still more at the safety cap ⇒ more may exist
    pageToken = res.data.nextPageToken;
  }

  const rowsUpserted = await withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      let n = 0;
      for (const row of parsedRows) {
        await c.query(
          `INSERT INTO search_campaign_metrics_daily
             (id, tenant_id, campaign_id, date, impressions, clicks, cost_minor, currency,
              conversions, conv_value_minor, source, connection_id, simulated, origin_site, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'google_ads_api',$11,$12,$13, now(), now())
           ON CONFLICT (campaign_id, date) DO UPDATE SET
             impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, cost_minor = EXCLUDED.cost_minor,
             currency = EXCLUDED.currency, conversions = EXCLUDED.conversions,
             conv_value_minor = EXCLUDED.conv_value_minor, source = EXCLUDED.source,
             connection_id = EXCLUDED.connection_id,
             -- Provenance travels with the payload it now describes, atomically, per the 0061 law this
             -- module already established — a live re-pull over a formerly-simulated row overwrites
             -- BOTH together, never one alone.
             simulated = EXCLUDED.simulated, updated_at = now()`,
          [
            newId(), p.tenantId, row.campaignId, row.date, row.impressions, row.clicks, row.costMinor,
            row.currency, row.conversions, row.convValueMinor, connectionId, simulated, config.originSite,
          ],
        );
        n++;
      }
      return n;
    },
    { modules: ["search"] },
  );

  return {
    engagementId: p.engagementId, status: "pulled", customerId,
    startDate, requestedEndDate: clamp.requestedEndDate, effectiveEndDate: clamp.effectiveEndDate,
    clampedForFreshness: clamp.clamped, freshnessLagDays: ADS_FRESHNESS_LAG_DAYS,
    campaignsTracked, campaignsWithInvalidExternalIdSkipped,
    rowsUpserted, malformedRowsSkipped, rowsOutsideRangeSkipped, rowsWrongCustomerSkipped, rowsUnmatchedCampaignSkipped,
    pagesFetched, truncated,
    provider: "google_ads", connectionId, simulated,
  };
}

// ── 3 · THE READER ───────────────────────────────────────────────────────────────────────────────

export interface AdsCampaignMetricsRow {
  id: string;
  date: string;
  impressions: number;
  clicks: number;
  costMinor: number;
  currency: string | null;
  conversions: number;
  convValueMinor: number;
  source: string | null;
  simulated: boolean | null;
  createdAt: string;
}

/** Raw history reader — BADGE, not filter (search.controller.ts's own established `listGscPerformance`/
 *  `listGa4Metrics`/`listRankSnapshots` disposition, §A4.7): every row already carries its own
 *  `simulated`/`source`, so a console can show a client's OWN CSV-imported/Ads-Scripts/live-API rows
 *  side by side without any of them silently vanishing the moment more than one pipe has written to
 *  this campaign. `simulated` is nullable in the SELECT shape because pre-SM-25c rows (CSV/Ads-Scripts,
 *  written before 0064 added the column) read back as the column's own NOT NULL DEFAULT false — never
 *  actually NULL on disk, but the reader's type says so honestly rather than assuming every writer of
 *  this table is this ticket's own code. */
export async function listAdsCampaignMetrics(args: {
  tenantId: string;
  campaignId: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<AdsCampaignMetricsRow[]> {
  const limit = Math.min(Math.max(Number(args.limit) || 500, 1), 5000);
  const rows = await withTenants(
    [args.tenantId],
    (c) => {
      const params: unknown[] = [args.campaignId];
      const clauses = ["campaign_id = $1"];
      if (args.startDate) { params.push(args.startDate); clauses.push(`date >= $${params.length}`); }
      if (args.endDate) { params.push(args.endDate); clauses.push(`date <= $${params.length}`); }
      params.push(limit);
      return c.query<{
        id: string; date: string; impressions: string; clicks: string; cost_minor: string; currency: string | null;
        conversions: string; conv_value_minor: string; source: string | null; simulated: boolean | null; created_at: string;
      }>(
        // `date::text`: node-pg's default type parser returns SQL `date` as a JS `Date` object, not a
        // string — this reader's own contract (`AdsCampaignMetricsRow.date: string`) must actually
        // deliver a string, not rely on a caller to know to re-format it (ga4-client.test.ts's own raw
        // verification query casts identically, for the same reason).
        `SELECT id, date::text AS date, impressions, clicks, cost_minor, currency, conversions, conv_value_minor,
                source, simulated, created_at
           FROM search_campaign_metrics_daily
          WHERE ${clauses.join(" AND ")}
          ORDER BY date DESC LIMIT $${params.length}`,
        params,
      );
    },
    { modules: ["search"] },
  );
  return rows.rows.map((r) => ({
    id: r.id, date: r.date,
    impressions: Number(r.impressions), clicks: Number(r.clicks), costMinor: Number(r.cost_minor),
    currency: r.currency, conversions: Number(r.conversions), convValueMinor: Number(r.conv_value_minor),
    source: r.source, simulated: r.simulated, createdAt: r.created_at,
  }));
}
