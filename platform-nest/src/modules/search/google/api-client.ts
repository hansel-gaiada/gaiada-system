// SM-25a — the AUTHORIZED-REQUEST client for the three Google data surfaces: Bearer attachment from
// the vault, refresh-on-401 with a single retry, and the per-surface base-URL seams. The SECOND (and
// last) new egress file in this module (design addendum §A12.1; §6e's egress-inventory set is amended
// deliberately, by exact filename, with this file and token-endpoint-client.ts).
//
// ── WHY THIS IS PART OF THE OAUTH CORE AND NOT OF SM-25b/SM-25c ───────────────────────────────────
// Token CUSTODY is this ticket's subject, and "attach the credential, notice it died, renew it, retry
// once, persist the rotation" is custody — it is the part where a mistake leaks or loses a credential.
// What this file deliberately does NOT do is understand Google's DATA: it returns parsed JSON and
// nothing else. Turning a `searchAnalytics/query` response into rows, choosing dimensions, deciding
// idempotent UNIQUE-day upserts and owning the perf-table migration are SM-25b's declared scope
// (`google/{gsc,ga4}-client.ts` + its own additive migration with senior-db eyes); the Ads read
// binding into the SM-20 tables is SM-25c's. Building those here would consume another ticket's
// migration slot and its controller edits, which the tracker's build order forbids taking concurrently.
// The seam is deliberately at the boundary where their work is pure assembly.
//
// ── QUOTA IS THE BOUNDING RESOURCE, NOT DOLLARS (§A12.1) ─────────────────────────────────────────
// Nothing here writes a USD ledger row, and nothing here goes through `dispatchProviderOp`: there is no
// money to meter on a client's own Google account, and inventing synthetic dollars would pollute §A3's
// cost-to-serve meaning. The bound is Google QUOTA, enforced as per-op row/page caps in each CONSUMING
// ticket's AC — this file exposes `maxRows`-style parameters upward rather than inventing a policy.
// And nothing here may write `search_data_cache`: that table is no-RLS shared market data by design
// (D-4), so client-private Search Console/GA4 rows in it would be a cross-tenant leak by construction.
//
// ── WHAT A GREEN RUN PROVES, AND WHAT IT DOES NOT ────────────────────────────────────────────────
// Against SM-51's sandbox this file's real HTTP path runs on real sockets: header serialization, the
// 401 → refresh → retry sequence, rotation persistence, and strict-path/strict-auth refusals. A green
// sandbox is a validated client of OUR OWN MODEL OF GOOGLE, not a validated Google integration.
// Deferred to SM-41G: whether real Google accepts these requests at all; real response shapes; the
// error-code inventory as actually emitted; quota/429 + `Retry-After` behaviour; and for Ads, developer-
// token approval + MCC/login-customer-id semantics.
import { config } from "../../../config";
import { GoogleApiError, GoogleConnectionNotLinkedError } from "./errors";
import { getAccessToken } from "./oauth";
import type { FetchImpl } from "./token-endpoint-client";

export type GoogleSurface = "search_console" | "analytics_data" | "ads";

function baseUrlFor(surface: GoogleSurface): string {
  const g = config.search.google;
  switch (surface) {
    case "search_console":
      return g.searchConsoleBaseUrl;
    case "analytics_data":
      return g.analyticsDataBaseUrl;
    case "ads":
      return g.adsBaseUrl;
  }
}

export interface AuthorizedRequest {
  tenantId: string;
  connectionId: string;
  surface: GoogleSurface;
  /** Path beginning with `/`, already URL-encoded by the caller where it embeds identifiers. */
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  fetchImpl?: FetchImpl;
}

export interface AuthorizedResponse<T> {
  data: T;
  status: number;
  /** True when a 401 forced a mid-flight refresh — surfaced so a test can PROVE the retry happened
   *  rather than infer it from a green result (the SM-49 hit-counter discipline, applied here). */
  refreshed: boolean;
}

/** One authorized call, with refresh-on-401 and EXACTLY ONE retry.
 *
 *  WHY ONE RETRY AND NOT A LOOP: a second 401 after a freshly-minted token is not a timing problem, it
 *  is a permission/revocation problem — the grant is gone, the scope is wrong, or the resource is not
 *  ours. Retrying that in a loop turns a clear failure into quota burn against the client's own Google
 *  project, which is the one resource §A12.1 says actually bounds us.
 *
 *  IDEMPOTENCY NOTE: the retry re-sends the same request. Every call this ticket's consumers make is a
 *  READ (`searchAnalytics/query`, `runReport`, `googleAds:search` — all POST-shaped reads). An Ads
 *  MUTATE must never be routed through this helper's retry: mutations belong to SM-26 through SM-21's
 *  approve-execute-replay + WS4 one-shot approval (§A12.1/D-8), where the replay decision is a human
 *  one. `assertReadOnlyPath` below makes that structural rather than advisory. */
export async function googleAuthorizedRequest<T>(req: AuthorizedRequest): Promise<AuthorizedResponse<T>> {
  assertReadOnlyPath(req.path);
  const fetchImpl = req.fetchImpl ?? fetch;
  let refreshed = false;

  const first = await getAccessToken(req.tenantId, req.connectionId, { fetchImpl });
  refreshed = first.refreshed;
  let res = await send(req, first.accessToken, fetchImpl);

  if (res.status === 401) {
    // The stored expiry said the token was fine and the surface disagreed. The surface wins: force a
    // renewal and try once more. `force` bypasses the skew check precisely because our own bookkeeping
    // has just been contradicted by the authority on the matter.
    const renewed = await getAccessToken(req.tenantId, req.connectionId, { force: true, fetchImpl });
    refreshed = true;
    res = await send(req, renewed.accessToken, fetchImpl);
  }

  if (res.status < 200 || res.status >= 300) {
    // 401 twice ⇒ report it as what it is: the connection is not usable, and a human must re-link.
    if (res.status === 401) throw new GoogleConnectionNotLinkedError(req.connectionId, "no_access_token");
    throw new GoogleApiError(req.surface, res.status, res.text);
  }

  let data: T;
  try {
    data = (res.text ? JSON.parse(res.text) : {}) as T;
  } catch {
    throw new GoogleApiError(req.surface, res.status, "non_json_response");
  }
  return { data, status: res.status, refreshed };
}

/** Structural guard against this READ helper being used for a mutation. Deliberately a thrown Error
 *  rather than a typed refusal: it can only fire on a code path that does not exist yet, so it is a
 *  developer tripwire for a future contributor, not a runtime condition any caller handles. Google's
 *  mutate endpoints are spelled `…:mutate` / `…:batchUpdate` / `…:runDownload`-style verbs after a
 *  colon, which is what this matches. */
function assertReadOnlyPath(path: string): void {
  if (/:(mutate|batchMutate|batchUpdate|create|update|delete)\b/i.test(path)) {
    throw new Error(
      `[search/google] refused: '${path}' looks like a Google MUTATE endpoint, and api-client.ts is the ` +
        "read helper (it retries requests, which a mutation must never do implicitly). Google Ads writes " +
        "are governed by SM-21's approve-execute-replay + WS4 one-shot approval regardless of transport " +
        "(design addendum §A12.1, D-8) — route the write there, not through this file.",
    );
  }
}

async function send(
  req: AuthorizedRequest,
  accessToken: string,
  fetchImpl: FetchImpl,
): Promise<{ status: number; text: string }> {
  const url = new URL(baseUrlFor(req.surface) + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  };
  if (req.body !== undefined) headers["content-type"] = "application/json";
  if (req.surface === "ads") {
    // Ads-only required headers. UNVERIFIED (SM-41G): a developer token must be APPROVED by Google
    // before it functions at all, and login-customer-id/MCC semantics cannot be rehearsed locally. When
    // unset these headers are simply absent, so the sandbox can still exercise the request path while a
    // real Ads call would be refused by Google — which is the honest local state, not a working Ads
    // integration.
    const g = config.search.google;
    if (g.adsDeveloperToken) headers["developer-token"] = g.adsDeveloperToken;
    if (g.adsLoginCustomerId) headers["login-customer-id"] = g.adsLoginCustomerId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.search.google.timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), {
      method: req.method ?? "GET",
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch {
    // 0 = we never got an answer (timeout/socket). Distinguished from any real HTTP status so a caller
    // can tell "Google refused" from "we never reached Google".
    return { status: 0, text: controller.signal.aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-surface request builders ──────────────────────────────────────────────────────────────────
// Thin on purpose: each one owns Google's PATH SHAPE (the part that must match the vendor exactly and
// that SM-41G will correct if it is wrong) and returns the raw parsed envelope. Response INTERPRETATION
// — field names, nullability, row semantics, persistence — belongs to SM-25b/SM-25c, whose tickets own
// the tables and the mode/`simulated` handling for them (the §A4.7 duty).

/** Search Console: the sites the connected account can access.
 *  `GET /webmasters/v3/sites` (Search Console API v3, still the current surface for site listing). */
export async function searchConsoleListSites<T = unknown>(args: {
  tenantId: string;
  connectionId: string;
  fetchImpl?: FetchImpl;
}): Promise<AuthorizedResponse<T>> {
  return googleAuthorizedRequest<T>({
    tenantId: args.tenantId,
    connectionId: args.connectionId,
    surface: "search_console",
    path: "/webmasters/v3/sites",
    method: "GET",
    fetchImpl: args.fetchImpl,
  });
}

/** Search Console Search Analytics — THE query the department has been missing.
 *  `POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query`; `siteUrl` is percent-encoded in the
 *  path because it is itself a URL (`https://example.com/` or `sc-domain:example.com`).
 *
 *  `rowLimit` is passed up rather than defaulted silently: the row cap IS the quota policy (§A12.1), and
 *  the consuming ticket's AC is where it belongs. Google's documented per-request maximum is 25 000
 *  rows — a documented figure, not one we have observed. */
export async function searchConsoleQuery<T = unknown>(args: {
  tenantId: string;
  connectionId: string;
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  rowLimit?: number;
  startRow?: number;
  searchType?: string;
  fetchImpl?: FetchImpl;
}): Promise<AuthorizedResponse<T>> {
  return googleAuthorizedRequest<T>({
    tenantId: args.tenantId,
    connectionId: args.connectionId,
    surface: "search_console",
    path: `/webmasters/v3/sites/${encodeURIComponent(args.siteUrl)}/searchAnalytics/query`,
    method: "POST",
    body: {
      startDate: args.startDate,
      endDate: args.endDate,
      ...(args.dimensions?.length ? { dimensions: args.dimensions } : {}),
      ...(args.rowLimit !== undefined ? { rowLimit: args.rowLimit } : {}),
      ...(args.startRow !== undefined ? { startRow: args.startRow } : {}),
      ...(args.searchType ? { type: args.searchType } : {}),
    },
    fetchImpl: args.fetchImpl,
  });
}

/** GA4 Data API: `POST /v1beta/properties/{propertyId}:runReport`.
 *  NOTE the `:runReport` suffix is a Google custom-method verb, NOT a mutation — `assertReadOnlyPath`'s
 *  pattern deliberately matches only mutate-shaped verbs, so this read passes. */
export async function ga4RunReport<T = unknown>(args: {
  tenantId: string;
  connectionId: string;
  /** Numeric GA4 property id, without the "properties/" prefix. */
  propertyId: string;
  body: unknown;
  fetchImpl?: FetchImpl;
}): Promise<AuthorizedResponse<T>> {
  return googleAuthorizedRequest<T>({
    tenantId: args.tenantId,
    connectionId: args.connectionId,
    surface: "analytics_data",
    path: `/v1beta/properties/${encodeURIComponent(args.propertyId)}:runReport`,
    method: "POST",
    body: args.body,
    fetchImpl: args.fetchImpl,
  });
}

/** Google Ads READ: `POST /{version}/customers/{customerId}/googleAds:search` with a GAQL query.
 *  READ ONLY — SM-25c's binding. Every Ads WRITE stays under SM-21 + WS4 approvals regardless of
 *  transport (§A12.1/D-8) and is explicitly out of this ticket's scope. */
export async function adsSearch<T = unknown>(args: {
  tenantId: string;
  connectionId: string;
  customerId: string;
  query: string;
  pageSize?: number;
  pageToken?: string;
  fetchImpl?: FetchImpl;
}): Promise<AuthorizedResponse<T>> {
  return googleAuthorizedRequest<T>({
    tenantId: args.tenantId,
    connectionId: args.connectionId,
    surface: "ads",
    path: `/${config.search.google.adsApiVersion}/customers/${encodeURIComponent(args.customerId)}/googleAds:search`,
    method: "POST",
    body: {
      query: args.query,
      ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
      ...(args.pageToken ? { pageToken: args.pageToken } : {}),
    },
    fetchImpl: args.fetchImpl,
  });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Google Ads MUTATE — the deliberately separate WRITE transport (SM-26; design addendum §A12.6 /
// §A14.5 "generalised to writes"; tracker §6bp Ruling 6)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// `assertReadOnlyPath` above is a STRUCTURAL guard and is not loosened by one character to accommodate
// this function — this is instead a second, deliberately-named function that never calls
// `googleAuthorizedRequest` (so the `:mutate` tripwire never even runs against it). It is reachable
// from exactly one place in production: SM-26's registered live `AdsExecutor`
// (`../sem-executor-google-ads.ts`), itself only invoked through SM-21's approve-execute-replay +
// WS4 one-shot approval (§A12.1/D-8) — never through any read path, never through a route this file's
// own callers would reach by accident.
//
// WHY ONE RETRY ON A CLEAN 401 IS STILL SAFE FOR A WRITE (unlike a retry-on-anything-else): a 401
// means the request never got past authentication — nothing reached Google's execution layer, so
// nothing can have been double-applied by refreshing the token and resending. What must NEVER happen
// is retrying a request whose OUTCOME is unknown (timeout, aborted mid-flight, a 5xx after the request
// was plausibly received) — those are left entirely to the caller's manifest-based reconciliation
// (§6bp Ruling 6: a count/shape mismatch, which a request that got no answer at all trivially
// produces, becomes `indeterminate`-all). This function never resends on anything but a clean 401.
//
// WHY THIS RETURNS THE RAW STATUS/BODY INSTEAD OF THROWING ON A NON-2XX (unlike
// `googleAuthorizedRequest`, which throws `GoogleApiError`): the caller's positional-pairing
// reconciliation needs to see the actual response SHAPE even when it is not a 2xx — Ads is documented
// to be able to answer with `partialFailureError` inside an otherwise-200 body, and a rejected mutate
// call is itself part of what "count/shape mismatch" means (§A14.5's pairing discriminator). Throwing
// here would collapse every non-2xx into one generic error and hide the shape from the reconciler.
export interface AdsMutateHttpResult<T = unknown> {
  status: number;
  data: T | null;
  refreshed: boolean;
}

export async function googleAdsMutateRequest<T = unknown>(args: {
  tenantId: string;
  connectionId: string;
  /** The full `/v{n}/customers/{customerId}/{resource}:mutate` path — already built by the caller
   *  (`sem-executor-google-ads.ts` owns the per-resource-type routing; this file owns transport only). */
  path: string;
  body: unknown;
  fetchImpl?: FetchImpl;
}): Promise<AdsMutateHttpResult<T>> {
  const req: AuthorizedRequest = {
    tenantId: args.tenantId,
    connectionId: args.connectionId,
    surface: "ads",
    path: args.path,
    method: "POST",
    body: args.body,
    fetchImpl: args.fetchImpl,
  };
  const fetchImpl = req.fetchImpl ?? fetch;

  const first = await getAccessToken(req.tenantId, req.connectionId, { fetchImpl });
  let refreshed = first.refreshed;
  let res = await send(req, first.accessToken, fetchImpl);

  if (res.status === 401) {
    // Same "the surface wins" reasoning as googleAuthorizedRequest's identical branch: our stored
    // expiry said the token was fine and Google disagreed, so force a renewal and try exactly once
    // more — safe here because a 401 means nothing was sent to the mutate RPC itself.
    const renewed = await getAccessToken(req.tenantId, req.connectionId, { force: true, fetchImpl });
    refreshed = true;
    res = await send(req, renewed.accessToken, fetchImpl);
  }

  if (res.status === 401) {
    // Still unauthenticated after a forced refresh: the connection itself is not usable, and — same
    // as the read path — nothing was sent, so throwing here is the executor's "nothing was sent"
    // contract, not a violation of it.
    throw new GoogleConnectionNotLinkedError(req.connectionId, "no_access_token");
  }

  let data: T | null = null;
  if (res.text) {
    try {
      data = JSON.parse(res.text) as T;
    } catch {
      // Non-JSON body on a mutate response is itself a shape fact the caller's reconciliation must
      // see (it will read as `data: null`, which fails the caller's own results-array shape check) —
      // never thrown away as a generic error the way the read helper's non-JSON branch does.
      data = null;
    }
  }
  return { status: res.status, data, refreshed };
}
