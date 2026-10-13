// PV6-02 — which Business area each service's card belongs to. The ids are v2 registry area or sub-area ids
// (Marketing's sub-areas keep their v1 ids). Kept as data so PV6-03 draws each card on its area's page from the
// same map, and a test pins every id against the registry so a rename cannot orphan a card silently.
import type { ServiceKey } from "./types";

export const SERVICE_AREA: Readonly<Record<ServiceKey, string>> = {
  social: "mk_social",
  search: "se",
  search_ads: "mk_paid",
  analytics: "mk_analytics",
  website: "mk_web",
};

export function areaFor(service: ServiceKey): string {
  return SERVICE_AREA[service];
}
