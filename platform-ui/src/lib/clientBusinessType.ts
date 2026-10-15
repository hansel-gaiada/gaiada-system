// PV3-04 (PV-D1) — the business-type rule on the staff side, as pure functions so the Clients page,
// the forms and their tests share one reading of it. No server-only imports: client-safe.
//
// WHAT "NOT SET" IS. The backend never stores "not set": a client with no Client Centre profile row reads
// as `other` (platform-nest `centre/store.ts`), so "explicitly other" and "never set" look the same on the
// wire. The review list therefore treats both alike — "Business type: Other or not set". The ONE place the
// two differ is the Edit form, which asks the centre read for its `revision`: 0 means no row, so nothing is
// preselected and the form will not submit until a type is chosen.
import type { CentreListItem } from "./clientCentre";

export const OTHER_BUSINESS_TYPE = "other";
/** The Clients-list filter value (`?review=business-type`). */
export const REVIEW_BUSINESS_TYPE = "business-type";

/** Does this client still need somebody to choose a business type? */
export function needsBusinessType(businessType: string | null | undefined): boolean {
  return !businessType || businessType === OTHER_BUSINESS_TYPE;
}

/** What the Edit form preselects. A centre read with `revision` 0 has NO profile row: the type it reports
 *  (`other`) is the backend's synthesised default, not a choice, so nothing is preselected. */
export function preselectedBusinessType(centre: { businessType: string; revision: number } | null | undefined): string | null {
  if (!centre || centre.revision === 0) return null;
  return centre.businessType;
}

export type CentreRead =
  | { ok: true; byClientId: Map<string, Pick<CentreListItem, "businessType">> }
  | { ok: false; message: string };

/** Turn the profile-list read into either a usable map or a REFUSAL to filter.
 *
 *  ⚠ An empty list must never stand in for a refusal. `listClientCentres` swallows 404/403 into `[]` (a
 *  module-off tenant), and the page used to `.catch(() => [])` everything else. The staff centre list
 *  returns ONE ROW PER CLIENT, so "there are clients but the profile list is empty" can only mean the read
 *  failed — and reading it as "every client has no type" would put the whole book on the review list. */
export function readCentres(
  clientCount: number,
  centres: CentreListItem[] | null,
  thrown?: unknown,
): CentreRead {
  if (thrown !== undefined || centres === null) {
    const why = thrown instanceof Error && thrown.message ? ` (${thrown.message})` : "";
    return { ok: false, message: `Business types could not be read just now${why}.` };
  }
  if (clientCount > 0 && centres.length === 0) {
    return { ok: false, message: "Business types could not be read just now: the profile list came back empty for a company that has clients." };
  }
  return { ok: true, byClientId: new Map(centres.map((c) => [c.clientId, c])) };
}

/** The `/clients` URL for a combination of the page's filters, keeping the others. */
export function clientsHref(f: { status?: string; archived?: boolean; review?: boolean; health?: string }): string {
  const q = new URLSearchParams();
  if (f.status) q.set("status", f.status);
  if (f.health) q.set("health", f.health);
  if (f.archived) q.set("archived", "1");
  if (f.review) q.set("review", REVIEW_BUSINESS_TYPE);
  const s = q.toString();
  return s ? `/clients?${s}` : "/clients";
}

/** The badge staff see on the internal sentinel client's row (`clients.is_internal`, WSK-D36): the client that
 *  owns our own sites. It is shown, not hidden, because staff may need to open it. */
export const INTERNAL_CLIENT_BADGE = "Internal (our own sites)";

/** Is this client on the review list? Only when the profile list was READ and says Other: a client the list
 *  did not mention is unknown, never "not set".
 *
 *  The internal sentinel client is NEVER on it (`isInternal`): a business type means nothing for the client
 *  that owns our own sites, so it must not be nagged for one. Said here and not left to "the centre list
 *  happens not to return it", which is a backend detail this rule should not depend on. */
export function inBusinessTypeReview(read: CentreRead, clientId: string, isInternal = false): boolean {
  if (isInternal) return false;
  if (!read.ok) return false;
  const c = read.byClientId.get(clientId);
  return c !== undefined && needsBusinessType(c.businessType);
}
