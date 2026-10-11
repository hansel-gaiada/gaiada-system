// PV3-05 — which client-hub tab is lit for a pathname. Pure and client-safe (ClientHubTabs is a
// client component), and in its own file so a unit test can pin the rule without rendering anything.
//
// Matching is on a PATH-SEGMENT boundary, the same rule `activePortalNav` (portalNav.ts) uses for the
// portal. A bare `startsWith` lit "Projects" (`/work`) for `/clients/x/workshop`, and would light any
// future tab whose segment is a prefix of another's. The Overview (index) tab is an exact match only,
// because every hub path starts with the base.

/** `/clients/<id>` for the Overview, `/clients/<id>/<segment>` otherwise. */
export function hubTabHref(clientId: string, segment: string): string {
  const base = `/clients/${clientId}`;
  return segment ? `${base}/${segment}` : base;
}

/** Drop a query/hash and trailing slashes, so `/clients/x/work/?a=1` and `/clients/x/work` agree. */
function normalizePath(pathname: string): string {
  return (pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
}

export function isHubTabActive(pathname: string, clientId: string, segment: string): boolean {
  const path = normalizePath(pathname);
  const href = hubTabHref(clientId, segment);
  if (!segment) return path === href;
  return path === href || path.startsWith(href + "/");
}
