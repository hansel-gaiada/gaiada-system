// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// The Google API error envelope shared by Search Console, the GA4 Data API and Google Ads
// (google.rpc.Status as rendered by the JSON/HTTP transcoding layer): `{error: {code, message, status,
// details?}}`. api-client.ts reads only the HTTP STATUS from a failure — it never parses this body into
// a decision — so the field names here are documentation for a future SM-25b/c parser rather than
// something a current assertion depends on.
//
// WHAT IS DOCS-ONLY AND DEFERRED TO SM-41G: which `status` Google actually emits for which condition,
// and above all the QUOTA path — whether an exhausted quota arrives as 429 `RESOURCE_EXHAUSTED`, as 403
// with a quota reason, whether a `Retry-After` header accompanies it, and how per-surface quotas differ.
// A locally-authored 429 fixture proves our code REACTS to a 429; it cannot establish that Google sends
// one, and nothing here should be read as if it did.
export function apiErrorBody(code: number, status: string, message: string) {
  return { error: { code, message, status } };
}

/** 401 shape — the one this ticket's tests genuinely depend on, because it is what drives
 *  api-client.ts's refresh-on-401 retry. */
export const UNAUTHENTICATED_BODY = apiErrorBody(
  401,
  "UNAUTHENTICATED",
  "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
);

/** 429 shape, present so a future quota-handling ticket has a fixture to drive. Modelled, NOT observed. */
export const RESOURCE_EXHAUSTED_BODY = apiErrorBody(429, "RESOURCE_EXHAUSTED", "Quota exceeded.");

/** 404 shape — a site/property/customer the connected account cannot see. */
export const NOT_FOUND_BODY = apiErrorBody(404, "NOT_FOUND", "The requested resource was not found.");
