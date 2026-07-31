// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// Google Ads API `GoogleAdsService.Search` response (the READ path): `{results: [...],
// fieldMask, nextPageToken?, totalResultsCount?}`.
//
// SHAPE FACTS FROM DOCS:
//   * money is in MICROS (1 000 000 micros = one currency unit) and arrives as a STRING. Reading
//     `cost_micros` as a currency amount is the classic 1e6 error; modelled as a string on purpose.
//     `conversions_value` is the ONE exception among the metrics fields modelled here — it is
//     documented as a plain currency-unit float (not micros), also serialized as a string.
//   * results are nested by RESOURCE, mirroring the GAQL SELECT clause (`campaign.id`,
//     `metrics.clicks`), and field names are snake_case in the JSON representation.
//   * `customer` and `segments` are requestable resources exactly like `campaign` — when a GAQL
//     SELECT names `customer.id`/`segments.date`, the response nests them per-row alongside
//     `campaign`/`metrics`, not once per response. SM-25c's own query always selects both (its own
//     echo-validation needs the per-row customer/date to verify against what it asked for), so this
//     fixture models them from day one rather than only the two fields SM-25a's original read-path
//     smoke test needed.
//   * pagination is `nextPageToken`, and its absence — not an empty results array — is what marks the
//     last page.
//
// SM-25c EXTENSION (2026-07-31, fixture-truthfulness corollary — tracker §6bi Ruling 2): this file
// was extended, not narrowed, to add `segments.date`/`customer.id`/`customer.currency_code`/
// `metrics.conversions_value` once SM-25c's ads-client.ts needed to echo-validate a response against
// the date window and customer id it queried for (§A14) — a query no earlier ticket issued. The
// original two-field shape (SM-25a's own smoke test, still pinned in google-sandbox-harness.test.ts)
// stays satisfiable: `date`/`customerId`/`currencyCode`/`conversionsValue` are all OPTIONAL on
// `AdsCampaignRowSpec` and default to realistic values, so no earlier caller of `adsSearchBody`/
// `defaultAdsSearch` needed to change to keep passing.
//
// WHAT THIS FIXTURE CANNOT MODEL, AND WHY AN ADS TEST PASSING PROVES LESS THAN THE OTHER TWO: a real
// Ads call requires a Google-APPROVED developer token, and MCC / login-customer-id semantics decide
// which customer a request may even address. Both are approval + account-topology facts that no local
// issuer can rehearse (SM-41G). This fixture exercises our request serialization and nothing about
// whether Google would accept it.
//
// ADS WRITES ARE OUT OF SCOPE HERE BY RULING, NOT BY OMISSION: every Ads mutation stays under SM-21's
// approve-execute-replay + WS4 one-shot approval regardless of transport (§A12.1/D-8). See
// ads-mutate.ts for the envelope SM-26 will build against, and note api-client.ts structurally refuses
// to send a mutate-shaped path.
export interface AdsCampaignRowSpec {
  campaignId: string;
  campaignName: string;
  status?: string;
  clicks: number;
  impressions: number;
  costMicros: number;
  conversions?: number;
  /** SM-25c. `YYYY-MM-DD` (Ads' own documented `segments.date` shape — no separators-stripped variant
   *  the way GA4's `YYYYMMDD` is). Defaults to "today minus one" (a plausible in-window day for a
   *  test that does not care about the exact date) rather than a fixed literal, so a fixture built
   *  once does not silently drift stale against a freshness-lag clamp computed from `new Date()`. */
  date?: string;
  /** SM-25c. Defaults to a stable placeholder distinct from any real customerId a test supplies, so a
   *  test that deliberately queries a DIFFERENT customerId than this default can prove the echo check
   *  actually fires (rather than the fixture coincidentally already matching). */
  customerId?: string;
  currencyCode?: string;
  conversionsValue?: number;
}

function defaultDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function adsSearchBody(args: { rows: AdsCampaignRowSpec[]; nextPageToken?: string | null }) {
  return {
    results: args.rows.map((r) => ({
      customer: {
        resourceName: `customers/${r.customerId ?? "0000000000"}`,
        id: r.customerId ?? "0000000000",
        currency_code: r.currencyCode ?? "USD",
      },
      campaign: {
        resourceName: `customers/${r.customerId ?? "0000000000"}/campaigns/${r.campaignId}`,
        id: r.campaignId,
        name: r.campaignName,
        status: r.status ?? "ENABLED",
      },
      segments: {
        date: r.date ?? defaultDate(),
      },
      metrics: {
        clicks: String(r.clicks),
        impressions: String(r.impressions),
        // MICROS, as a STRING — see header.
        cost_micros: String(r.costMicros),
        conversions: String(r.conversions ?? 0),
        // A plain currency-unit float (NOT micros), also a STRING — see header.
        conversions_value: String(r.conversionsValue ?? 0),
      },
    })),
    fieldMask:
      "customer.id,customer.currency_code,campaign.id,campaign.name,campaign.status,segments.date," +
      "metrics.clicks,metrics.impressions,metrics.cost_micros,metrics.conversions,metrics.conversions_value",
    ...(args.nextPageToken ? { nextPageToken: args.nextPageToken } : {}),
  };
}

/** Deterministic default for an unseeded customer id — the row's OWN `customer.id` echoes the SAME
 *  customerId the URL path addressed (google-server.ts's `handleAds` passes it through), which is
 *  the honest unseeded default: an unseeded sandbox modelling a well-behaved vendor, not one that
 *  fails the echo check by construction. A test that wants to PROVE the echo check fires seeds an
 *  explicit mismatched customerId via `seedAdsSearch` instead of relying on this default. */
export function defaultAdsSearch(customerId: string) {
  let h = 5381;
  for (let i = 0; i < customerId.length; i++) h = (h * 33) ^ customerId.charCodeAt(i);
  const clicks = 50 + ((h >>> 0) % 450);
  return adsSearchBody({
    rows: [
      {
        campaignId: String(1000000 + ((h >>> 0) % 999999)),
        campaignName: "Sandbox Search Campaign",
        clicks,
        impressions: clicks * 12,
        costMicros: clicks * 250000,
        conversions: Math.floor(clicks / 10),
        customerId,
      },
    ],
  });
}
