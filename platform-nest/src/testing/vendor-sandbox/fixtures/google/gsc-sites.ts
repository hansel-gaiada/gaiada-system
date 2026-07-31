// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// Search Console API v3 `sites.list` response: `{siteEntry: [{siteUrl, permissionLevel}]}`.
//
// `permissionLevel` values are the documented enum (siteOwner / siteFullUser / siteRestrictedUser /
// siteUnverifiedUser). The one that matters operationally is `siteUnverifiedUser`: a connected account
// can SEE a property it cannot query, so "the OAuth link worked" and "we can read this site's data" are
// different facts. Whether Google reports that consistently is an SM-41G observation.
//
// `sc-domain:` prefixed entries are Domain properties (as against URL-prefix properties); both forms are
// included because the siteUrl is percent-encoded into the searchAnalytics path and the two forms encode
// differently — a client that only ever handled one form would pass a single-shape fixture and fail live.
export interface GscSiteEntry {
  siteUrl: string;
  permissionLevel: "siteOwner" | "siteFullUser" | "siteRestrictedUser" | "siteUnverifiedUser";
}

export const DEFAULT_GSC_SITES: GscSiteEntry[] = [
  { siteUrl: "https://sandbox-client.example/", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:sandbox-client.example", permissionLevel: "siteFullUser" },
  { siteUrl: "https://sandbox-unverified.example/", permissionLevel: "siteUnverifiedUser" },
];

export function gscSitesBody(entries: GscSiteEntry[]) {
  return { siteEntry: entries };
}
