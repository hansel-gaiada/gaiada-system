// SMM-38 phase 38c (design addendum §PD) — the LinkedIn wire client. HTTP + JSON against
// `api.linkedin.com` / `www.linkedin.com/oauth`, and nothing else — no Postiz import, no shared
// type, mirroring `publisher/postiz.ts`'s own containment discipline even though there is no
// licence-zone boundary to keep here: LinkedIn is a network the platform speaks to DIRECTLY, which
// is the entire point of D-20's `direct` driver.
//
// ── WHAT IS VERIFIED AND WHAT IS NOT — read this before trusting a route below ──────────────────
// 🚨 NO LIVE LINKEDIN APP CREDENTIAL EXISTS (D-23 defers all platform-app review to staging). Every
// route, header and payload shape below is reasoned from LinkedIn's PUBLISHED Community Management
// API docs (dossier §4, `docs/blueprints/smm-app-review-dossier.md`), never driven against a real
// app. They are collected in ONE file, behind ONE small set of functions, on purpose — exactly
// `postiz.ts`'s own precedent: when SMM-07-for-LinkedIn (or a later seat) first drives a live app,
// correcting a wire detail is a single edit in a single place, not a hunt through the module. Every
// ⚠UNVERIFIED marker below is a promise to re-check, not a guess dressed up as a fact.
//
// ── SCOPES THIS CLIENT ASSUMES (dossier §4.2) ───────────────────────────────────────────────────
//   publish org-page posts   → w_organization_social
//   read org-page comments   → r_organization_social_feed  (NOT r_organization_social — the single
//                               most rejection-prone detail on LinkedIn: a submission naming only
//                               r_organization_social is approved and then fails at RUNTIME on every
//                               comment-read call, dossier §4.2)
// This client does not request scopes itself — `linkedin-oauth.ts`'s authorize-URL builder does —
// but every method here assumes the grant it is handed already carries the scope its call needs,
// and a 403 from LinkedIn is surfaced as `publisher_http_error` (carrying the real status), never
// silently retried with a different scope.
//
// ── TIMEOUTS ────────────────────────────────────────────────────────────────────────────────────
// Two classes (config.social.direct.linkedin), same reasoning as postiz.ts's own three: a plain
// read/write budget, and a separate, larger one for the asset-upload dance (register → PUT bytes →
// finalize is three round trips, not one).
import { config } from "../../../config";
import { SocialPublisherError, type InboxItem } from "./types";

/** THE ONE PLACE a LinkedIn route string may appear. See the header for what is verified. */
export const LINKEDIN_ROUTES = {
  posts: "/rest/posts",                                                    // ⚠UNVERIFIED wire shape
  images: "/rest/images",                                                  // ⚠UNVERIFIED wire shape
  socialActionsComments: (shareUrn: string) => `/rest/socialActions/${encodeURIComponent(shareUrn)}/comments`, // ⚠UNVERIFIED
} as const;

export interface LinkedInAppCredentials {
  clientId: string;
  clientSecret: string;
}

/** Config's own env-backed credential pair. ONE LinkedIn app per deployment (dossier §4.6: "create a
 *  brand-new developer app with no other API products on it") — own-brand-first, D-20/OQ-3 unchanged
 *  — so unlike `publisher/keys.ts`'s per-org alias indirection there is deliberately no second alias
 *  layer here: `credential_ref` on `social_platform_apps` (0105) stays the ADMINISTRATIVE fact "an
 *  app is registered for this network", and the actual secret is this single, fixed env pair. */
export function linkedInAppCredentials(): LinkedInAppCredentials {
  return {
    clientId: config.social.direct.linkedin.clientId,
    clientSecret: config.social.direct.linkedin.clientSecret,
  };
}

export function hasLinkedInAppCredentials(): boolean {
  const c = linkedInAppCredentials();
  return c.clientId.length > 0 && c.clientSecret.length > 0;
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  /** Seconds, per LinkedIn's `expires_in`. */
  expiresInSeconds: number;
  /** Seconds, per LinkedIn's `refresh_token_expires_in` — LinkedIn's refresh tokens are long-lived
   *  (365 days, addendum §A4e) and do NOT reset on use, so this is worth carrying separately from
   *  the access token's own short expiry. */
  refreshTokenExpiresInSeconds?: number;
  /** Space-delimited scope string LinkedIn actually granted, per OAuth §5.1 — may be narrower than
   *  requested. `undefined` when the token response omitted it (never defaulted to "granted everything"). */
  scope?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function parseTokenResponse(raw: unknown): TokenResult {
  const rec = asRecord(raw);
  const accessToken = str(rec.access_token);
  if (!accessToken) {
    throw new SocialPublisherError("publisher_http_error", "LinkedIn token endpoint returned no access_token");
  }
  const expiresIn = num(rec.expires_in);
  return {
    accessToken,
    refreshToken: str(rec.refresh_token),
    expiresInSeconds: expiresIn ?? 0,
    refreshTokenExpiresInSeconds: num(rec.refresh_token_expires_in),
    scope: str(rec.scope),
  };
}

export interface LinkedInFetchOptions {
  fetchImpl?: typeof fetch;
}

/** The one outbound call to LinkedIn's TOKEN endpoint (`www.linkedin.com/oauth/v2/accessToken`) —
 *  form-encoded, per OAuth §4.1/§6, never JSON (LinkedIn's token endpoint does not accept a JSON
 *  body — ⚠UNVERIFIED against a live app, but this is standard OAuth2 and the documented shape). */
async function callTokenEndpoint(
  params: Record<string, string>,
  opts: LinkedInFetchOptions = {},
): Promise<TokenResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.social.direct.linkedin.readTimeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(config.social.direct.linkedin.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SocialPublisherError(
      "publisher_unreachable",
      `LinkedIn token endpoint did not answer: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new SocialPublisherError("publisher_http_error", "LinkedIn token endpoint returned non-JSON", res.status);
  }
  if (!res.ok) {
    // LinkedIn's error body carries `error`/`error_description` (OAuth §5.2). The upstream BODY is
    // not re-thrown verbatim (same discipline as postiz.ts) — only the fact that it failed, and its
    // status, cross the boundary into our own surfaces.
    const rec = asRecord(parsed);
    throw new SocialPublisherError(
      "publisher_http_error",
      `LinkedIn token endpoint answered HTTP ${res.status}${str(rec.error) ? ` (${rec.error})` : ""}`,
      res.status,
    );
  }
  return parseTokenResponse(parsed);
}

/** Authorization-code exchange — the ONE call the OAuth callback makes. */
export async function exchangeAuthorizationCode(
  args: { code: string; redirectUri: string },
  opts: LinkedInFetchOptions = {},
): Promise<TokenResult> {
  const creds = linkedInAppCredentials();
  return callTokenEndpoint(
    {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    },
    opts,
  );
}

/** Refresh-token exchange — the function `linkedin-oauth.ts` registers with
 *  `oauth-tokens.ts`'s `registerTokenRefresher('linkedin', ...)`. */
export async function refreshWithRefreshToken(
  refreshToken: string,
  opts: LinkedInFetchOptions = {},
): Promise<TokenResult> {
  const creds = linkedInAppCredentials();
  return callTokenEndpoint(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    },
    opts,
  );
}

/** The one outbound call to LinkedIn's REST API (`api.linkedin.com`), Bearer-authenticated, with the
 *  versioned header the Community Management API requires on every call. Stateless per call — the
 *  access token is a parameter, never retained (port invariant 2, types.ts's header). */
async function callRestApi<T>(
  accessToken: string,
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number; raw?: { bytes: Uint8Array; contentType: string } },
  opts: LinkedInFetchOptions = {},
): Promise<{ status: number; headers: Headers; body: T | undefined }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? config.social.direct.linkedin.readTimeoutMs,
  );
  let res: Response;
  try {
    res = await fetchImpl(`${config.social.direct.linkedin.apiBaseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.raw
          ? { "Content-Type": init.raw.contentType }
          : {
            "Content-Type": "application/json",
            "LinkedIn-Version": config.social.direct.linkedin.apiVersion,
            "X-Restli-Protocol-Version": "2.0.0",
          }),
      },
      body: init.raw ? (init.raw.bytes as unknown as BodyInit) : (init.body === undefined ? undefined : JSON.stringify(init.body)),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SocialPublisherError(
      "publisher_unreachable",
      `LinkedIn did not answer ${init.method} ${path}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new SocialPublisherError(
      "publisher_http_error",
      `LinkedIn answered HTTP ${res.status} for ${init.method} ${path}`,
      res.status,
    );
  }
  const text = await res.text();
  if (!text) return { status: res.status, headers: res.headers, body: undefined };
  try {
    return { status: res.status, headers: res.headers, body: JSON.parse(text) as T };
  } catch {
    throw new SocialPublisherError("publisher_http_error", `LinkedIn returned non-JSON for ${init.method} ${path}`, res.status);
  }
}

export interface PublishOrganizationPostArgs {
  organizationUrn: string;
  commentary: string;
  /** Already-registered LinkedIn image/video URNs (see `registerImageUpload`/`uploadImageBytes`). */
  mediaUrns?: string[];
}

/** LinkedIn Posts API — org-page publish (dossier §4.2, scope `w_organization_social`). Returns the
 *  created post's URN, LinkedIn's own analogue of `providerPostId`.
 *
 *  ⚠UNVERIFIED response shape: LinkedIn's REST convention for a POST that creates a resource is to
 *  return 201 with NO body and the new URN in the `x-restli-id` response header — never driven
 *  against a live app, so this is reasoned from the Community Management API docs' own pattern for
 *  every other `/rest/*` create route, not from a captured response. If a real app instead returns
 *  the URN in a JSON body, this is the one function to correct (see the file header). */
export async function publishOrganizationPost(
  accessToken: string,
  args: PublishOrganizationPostArgs,
  opts: LinkedInFetchOptions = {},
): Promise<{ providerPostId: string }> {
  const body: Record<string, unknown> = {
    author: args.organizationUrn,
    commentary: args.commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
    ...(args.mediaUrns?.length
      ? {
        content: {
          media: {
            id: args.mediaUrns[0],
            title: undefined,
          },
        },
      }
      : {}),
  };
  const res = await callRestApi<unknown>(accessToken, LINKEDIN_ROUTES.posts, { method: "POST", body }, opts);
  const fromHeader = res.headers.get("x-restli-id");
  const fromBody = str(asRecord(res.body).id);
  const providerPostId = fromHeader ?? fromBody;
  if (!providerPostId) {
    // Ambiguous publish outcome — accepted (2xx already checked by callRestApi) but no id anywhere
    // this client knows to look. Refused loudly, never retried here (design §11's "no auto-retry of
    // ambiguous publish failures" — the same rule postiz.ts's own schedulePost enforces).
    throw new SocialPublisherError(
      "publisher_http_error",
      "LinkedIn accepted the post but returned no URN in `x-restli-id` or the response body — "
      + "outcome AMBIGUOUS, not retried (design §11)",
    );
  }
  return { providerPostId };
}

export interface RegisteredUpload {
  /** The presigned URL to PUT raw bytes to. */
  uploadUrl: string;
  /** The image/video URN to reference from a subsequent post. */
  assetUrn: string;
}

/** Step 1 of LinkedIn's 3-step asset flow: register an upload for the organization, get back a
 *  presigned PUT url + the asset's URN. ⚠UNVERIFIED end to end (dossier §4 names no live test). */
export async function registerImageUpload(
  accessToken: string,
  organizationUrn: string,
  opts: LinkedInFetchOptions = {},
): Promise<RegisteredUpload> {
  const res = await callRestApi<unknown>(
    accessToken,
    `${LINKEDIN_ROUTES.images}?action=initializeUpload`,
    { method: "POST", body: { initializeUploadRequest: { owner: organizationUrn } } },
    opts,
  );
  const value = asRecord(asRecord(res.body).value);
  const uploadUrl = str(value.uploadUrl);
  const assetUrn = str(value.image);
  if (!uploadUrl || !assetUrn) {
    throw new SocialPublisherError("publisher_http_error", "LinkedIn returned no uploadUrl/image URN for an image upload registration");
  }
  return { uploadUrl, assetUrn };
}

/** Step 2: PUT the raw bytes to the presigned URL from step 1. LinkedIn's own upload timeout class
 *  (config.social.direct.linkedin.uploadTimeoutMs) — a genuinely different budget from a plain API
 *  read, same reasoning as postiz.ts's own upload class. */
export async function uploadImageBytes(
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: string,
  opts: LinkedInFetchOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.social.direct.linkedin.uploadTimeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes as unknown as BodyInit,
      signal: controller.signal,
    });
  } catch (err) {
    throw new SocialPublisherError("publisher_unreachable", `LinkedIn asset PUT did not complete: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new SocialPublisherError("publisher_http_error", `LinkedIn asset PUT answered HTTP ${res.status}`, res.status);
  }
}

/** The comment READ — dossier §4's single most rejection-prone scope detail: this needs
 *  `r_organization_social_feed`, not `r_organization_social`. `shareUrn` names ONE post — see
 *  `direct.ts`'s header for why this is per-post, not per-account (LinkedIn has no "every comment on
 *  my page" endpoint). `since` is applied CLIENT-SIDE: ⚠UNVERIFIED whether the endpoint accepts a
 *  server-side time filter at all, so this normalizer never assumes one, the same tolerant discipline
 *  postiz.ts's own normalizers use for an unverified envelope. */
export async function getPostComments(
  accessToken: string,
  shareUrn: string,
  since: Date,
  opts: LinkedInFetchOptions = {},
): Promise<InboxItem[]> {
  const res = await callRestApi<unknown>(accessToken, LINKEDIN_ROUTES.socialActionsComments(shareUrn), { method: "GET" }, opts);
  return normalizeComments(res.body, shareUrn, since);
}

/** ⚠UNVERIFIED envelope. Reasoned from LinkedIn's general `elements: [...]` collection convention
 *  used across its REST APIs. Absent fields stay absent — never defaulted, matching every other
 *  normalizer in this module (postiz.ts's own "unknown is not zero" doctrine). A row this client
 *  cannot key (no comment id) is skipped, never guessed at. */
export function normalizeComments(raw: unknown, shareUrn: string, since: Date): InboxItem[] {
  const rec = asRecord(raw);
  const rows = Array.isArray(rec.elements) ? rec.elements as unknown[] : [];
  const out: InboxItem[] = [];
  for (const r of rows) {
    const c = asRecord(r);
    const id = str(c.$URN) ?? str(c.id);
    if (!id) continue;
    const createdMs = num(asRecord(c.created).time) ?? num(c.createdAt);
    const postedAt = createdMs ? new Date(createdMs).toISOString() : undefined;
    if (postedAt && new Date(postedAt) < since) continue;
    out.push({
      externalId: id,
      externalThreadId: shareUrn,
      kind: "comment",
      // LinkedIn's commenter identity is an ACTOR URN, not a handle/display name — dossier §A4e's
      // 24h profile-data purge window applies to exactly this field once a real name is resolvable.
      // ⚠UNVERIFIED whether this endpoint ever inlines a display name; left absent rather than guessed.
      authorHandle: str(c.actor),
      authorName: undefined,
      body: str(c.message && asRecord(c.message).text) ?? "",
      postedAt: postedAt ?? since.toISOString(),
    });
  }
  return out;
}
