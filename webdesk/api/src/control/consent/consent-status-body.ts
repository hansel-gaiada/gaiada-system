// M5-V3-a -- the strict parser for the consent.status body. Pure: no Nest, no database.
//
//   { siteSlug?: string, consentIds: uuid[1..100] }
//
// `siteSlug` follows the Zone B convention (forms.service.ts: the "siteSlug" a fact carries IS the tenant slug; a
// WebDesk site row has no slug of its own). The tenant is already in the route, so the member is optional, and when
// it is present it must name that same tenant (the service answers 404 otherwise). Unknown body keys are refused.
// Ids are lower-cased and de-duplicated (order kept). The 100-id cap applies to what the caller SENT, so a
// 101-element array is always a 400, whatever it repeats.
import { problems } from "../content/content-problem";

export const CONSENT_STATUS_MAX_IDS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set(["siteSlug", "consentIds"]);

export interface ConsentStatusRequest {
  siteSlug: string | null;
  /** Lower-cased, distinct, in first-seen order. */
  consentIds: string[];
}

export function parseConsentStatusBody(raw: unknown): ConsentStatusRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw problems.invalidRequest("the body must be a JSON object");
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(k)) throw problems.invalidRequest(`unknown body member "${k}" (allowed: siteSlug, consentIds)`);
  }
  let siteSlug: string | null = null;
  if (body.siteSlug !== undefined) {
    if (typeof body.siteSlug !== "string" || body.siteSlug.length === 0 || body.siteSlug.length > 200) {
      throw problems.invalidRequest("siteSlug must be a non-empty string of at most 200 characters");
    }
    siteSlug = body.siteSlug;
  }
  const ids = body.consentIds;
  if (!Array.isArray(ids) || ids.length < 1) throw problems.invalidRequest("consentIds must be an array of 1 to 100 uuids");
  if (ids.length > CONSENT_STATUS_MAX_IDS) throw problems.invalidRequest(`consentIds may hold at most ${CONSENT_STATUS_MAX_IDS} ids`);
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !UUID_RE.test(id)) throw problems.invalidRequest("every consentIds entry must be a uuid");
    seen.add(id.toLowerCase());
  }
  return { siteSlug, consentIds: [...seen] };
}
