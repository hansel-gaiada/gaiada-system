// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Ahrefs /site-explorer/domain-rating shape — CONFIRMED per ahrefs.ts's own header
// (`{"domain_rating": {...}}` is the one independently-verified wrapper key). getBacklinkSummary
// reads `domain_rating.domain_rating`.
export interface DomainRatingParams {
  domain_rating: number;
}

export function domainRatingEnvelope(params: DomainRatingParams) {
  return { domain_rating: params };
}
