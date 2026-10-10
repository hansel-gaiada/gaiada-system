// PV2-05 — the pure half of the portal company resolver. No `server-only`, no cookies, so it is
// unit-testable. The cookie read and the switch action live in `./portal-company.ts`.

export interface PortalCompany {
  id: string;
  name: string;
}

export interface ClientOfEntry {
  companyId: string;
  companyName: string;
}

/**
 * Choose which company the portal shows.
 *   1. A cookie value that names a company in `clientOf` wins (an unknown value is ignored).
 *   2. Otherwise the first company by name (which is the only one when there is exactly one).
 *   3. With none, null: the pages turn that into the staff teach-state.
 * It takes ONLY `clientOf`. It must never be handed `me.companies`: a company the caller is merely
 * employed by is not a company they are a client of.
 */
export function pickPortalCompany(
  clientOf: readonly ClientOfEntry[] | null | undefined,
  cookieValue: string | null | undefined,
): PortalCompany | null {
  const list = clientOf ?? [];
  if (list.length === 0) return null;
  if (cookieValue) {
    const hit = list.find((c) => c.companyId === cookieValue);
    if (hit) return { id: hit.companyId, name: hit.companyName };
  }
  const first = [...list].sort((a, b) => a.companyName.localeCompare(b.companyName))[0];
  return { id: first.companyId, name: first.companyName };
}
