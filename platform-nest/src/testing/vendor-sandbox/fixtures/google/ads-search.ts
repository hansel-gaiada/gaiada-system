// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// Google Ads API `GoogleAdsService.Search` response (the READ path): `{results: [...],
// fieldMask, nextPageToken?, totalResultsCount?}`.
//
// SHAPE FACTS FROM DOCS:
//   * money is in MICROS (1 000 000 micros = one currency unit) and arrives as a STRING. Reading
//     `cost_micros` as a currency amount is the classic 1e6 error; modelled as a string on purpose.
//   * results are nested by RESOURCE, mirroring the GAQL SELECT clause (`campaign.id`,
//     `metrics.clicks`), and field names are snake_case in the JSON representation.
//   * pagination is `nextPageToken`, and its absence — not an empty results array — is what marks the
//     last page.
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
}

export function adsSearchBody(args: { rows: AdsCampaignRowSpec[]; nextPageToken?: string | null }) {
  return {
    results: args.rows.map((r) => ({
      campaign: {
        resourceName: `customers/0000000000/campaigns/${r.campaignId}`,
        id: r.campaignId,
        name: r.campaignName,
        status: r.status ?? "ENABLED",
      },
      metrics: {
        clicks: String(r.clicks),
        impressions: String(r.impressions),
        // MICROS, as a STRING — see header.
        cost_micros: String(r.costMicros),
        conversions: String(r.conversions ?? 0),
      },
    })),
    fieldMask: "campaign.id,campaign.name,campaign.status,metrics.clicks,metrics.impressions,metrics.cost_micros,metrics.conversions",
    ...(args.nextPageToken ? { nextPageToken: args.nextPageToken } : {}),
  };
}

/** Deterministic default for an unseeded customer id. */
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
      },
    ],
  });
}
