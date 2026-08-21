// SMM-38 phase 38d (design addendum §PD) — the YouTube wire client. HTTP + JSON against
// `oauth2.googleapis.com` (token) and `www.googleapis.com` (Data API v3 + the resumable-upload
// endpoint), and nothing else — mirrors `linkedin-client.ts`'s own containment discipline (38c's
// file), which itself mirrors `postiz.ts`'s: every route this client speaks lives in ONE file,
// behind ONE small set of functions, so a later seat correcting a wire detail against a real app has
// exactly one place to look.
//
// ── WHY THIS DOES NOT REUSE `core/google-oauth/token-endpoint-client.ts` ───────────────────────────
// That file is hard-wired to `config.google.*` — the SEARCH module's own Google Cloud OAuth app
// (Search Console / Analytics / Ads scopes; the app-review dossier's own §8 mapping table lists
// "Gaiada YouTube" as its OWN, separate `social_platform_apps` row, distinct from search's older
// Google app and from LinkedIn's app). Reusing that file here would either silently borrow search's
// client credentials for YouTube's own OAuth consent (wrong app, wrong scope-sensitivity review,
// wrong verification track — dossier §6.3) or require widening a CORE file outside this ticket's
// surface. So — the SAME call `linkedin-client.ts` made about not reusing
// `core/google-oauth/state.ts` — this file builds its OWN token client against
// `config.social.direct.youtube.*`, even though the wire PROTOCOL (RFC 6749 form-encoded token
// exchange) is identical: same shape, different credentials, kept separate on purpose.
//
// ── NO PKCE, NAMED AS A DELIBERATE SIMPLIFICATION ───────────────────────────────────────────────────
// `core/google-oauth` uses PKCE (public-client-shaped, per its own design). This client's
// authorization-code exchange does not: `direct`'s YouTube app is a CONFIDENTIAL client
// (`client_secret` is always present server-side, mirroring `linkedin-client.ts`'s own shape exactly
// — "Follow that shape" was this ticket's own instruction), and a confidential client authenticating
// with its secret does not need PKCE's code-verifier defence against a public client's inability to
// hold one. Named here rather than silently decided, since the estate's other Google OAuth precedent
// does use it for a different reason (a different client type).
//
// ── WHAT IS VERIFIED AND WHAT IS NOT — read this before trusting a route below ──────────────────────
// 🚨 NO LIVE YOUTUBE APP CREDENTIAL EXISTS (D-23 defers all platform-app review to staging). Every
// route, header and payload shape below is reasoned from YouTube's PUBLISHED Data API v3 docs
// (dossier §6, `docs/blueprints/smm-app-review-dossier.md`), never driven against a real app. Every
// ⚠UNVERIFIED marker below is a promise to re-check, not a guess dressed up as a fact.
//
// ── SCOPES THIS CLIENT ASSUMES (dossier §6.2) ───────────────────────────────────────────────────────
//   upload a video           → https://www.googleapis.com/auth/youtube.upload
//   read/write comments      → https://www.googleapis.com/auth/youtube.force-ssl
// This client does not request scopes itself — `youtube-oauth.ts`'s authorize-URL builder does — but
// every method here assumes the grant it is handed already carries the scope its call needs, and a
// 403 from Google is surfaced as `publisher_http_error` (carrying the real status), never silently
// retried with a different scope.
//
// ── THE FORCED-PRIVATE LOCK (dossier §6.3, community-reported, UNVERIFIED, NOT restated in current
// first-party docs) — a video uploaded via `videos.insert` from an unaudited API project may be
// silently forced to `privacyStatus: private` regardless of what this client requests. This client
// requests `private` explicitly (see `initiateResumableUpload`'s default) — the SAFE default that
// happens to match the reported lock, not a workaround for it — because `capabilities.ts`'s own
// YouTube row already models `directPost: false` for exactly this reason: nothing here should ever
// promise a public upload this phase cannot honour.
//
// ── TIMEOUTS ─────────────────────────────────────────────────────────────────────────────────────
// Two classes (config.social.direct.youtube), same reasoning as postiz.ts's/linkedin-client.ts's own:
// a plain read/write budget, and a separate, larger one for the resumable-upload dance (initiate →
// PUT bytes is two round trips, and the second one moves real bytes).
import { config } from "../../../config";
import { SocialPublisherError, type InboxItem } from "./types";

/** THE ONE PLACE a YouTube route string may appear. See the header for what is verified. */
export const YOUTUBE_ROUTES = {
  // `part=snippet,status` mirrors the metadata this client sends on initiate (title/description +
  // privacyStatus) — Google's resumable-upload doc requires naming every part you intend to set.
  uploadInitiate: "?uploadType=resumable&part=snippet,status",                       // ⚠UNVERIFIED wire shape
  commentThreads: (videoId: string) => `/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&textFormat=plainText`, // ⚠UNVERIFIED
} as const;

export interface YouTubeAppCredentials {
  clientId: string;
  clientSecret: string;
}

/** Config's own env-backed credential pair — ONE YouTube/Google Cloud app per deployment (dossier
 *  §6.6 checklist: "Google Cloud project under a Gaiada Workspace account"), own-brand-first
 *  (D-20/OQ-3 unchanged). See this file's header for why it is not `config.google`. */
export function youTubeAppCredentials(): YouTubeAppCredentials {
  return {
    clientId: config.social.direct.youtube.clientId,
    clientSecret: config.social.direct.youtube.clientSecret,
  };
}

export function hasYouTubeAppCredentials(): boolean {
  const c = youTubeAppCredentials();
  return c.clientId.length > 0 && c.clientSecret.length > 0;
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  /** Seconds, per RFC 6749's `expires_in`. */
  expiresInSeconds: number;
  /** Google's refresh tokens do not expire on their own documented terms (unlike LinkedIn's 365-day
   *  TTL) — ⚠UNVERIFIED in this pass; `core/google-oauth`'s own SM-41G note names this exact
   *  question as unresolved for THAT app, and this is a different app. `undefined` when the token
   *  response omitted a `refresh_token_expires_in`-shaped field (never defaulted to "never expires"). */
  refreshTokenExpiresInSeconds?: number;
  /** Space-delimited scope string Google actually granted — may be NARROWER than requested (Google's
   *  own incremental-consent semantics). `undefined` when the response omitted it. */
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
    throw new SocialPublisherError("publisher_http_error", "Google token endpoint returned no access_token");
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

export interface YouTubeFetchOptions {
  fetchImpl?: typeof fetch;
}

/** The one outbound call to Google's TOKEN endpoint — form-encoded, per RFC 6749 §4.1/§6. */
async function callTokenEndpoint(
  params: Record<string, string>,
  opts: YouTubeFetchOptions = {},
): Promise<TokenResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.social.direct.youtube.readTimeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(config.social.direct.youtube.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SocialPublisherError(
      "publisher_unreachable",
      `Google token endpoint did not answer: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new SocialPublisherError("publisher_http_error", "Google token endpoint returned non-JSON", res.status);
  }
  if (!res.ok) {
    // The upstream BODY is not re-thrown verbatim (same discipline as postiz.ts/linkedin-client.ts) —
    // only the fact that it failed, and its status, cross the boundary into our own surfaces.
    const rec = asRecord(parsed);
    throw new SocialPublisherError(
      "publisher_http_error",
      `Google token endpoint answered HTTP ${res.status}${str(rec.error) ? ` (${rec.error})` : ""}`,
      res.status,
    );
  }
  return parseTokenResponse(parsed);
}

/** Authorization-code exchange — the ONE call the OAuth callback makes. No PKCE — see this file's
 *  header for why. */
export async function exchangeAuthorizationCode(
  args: { code: string; redirectUri: string },
  opts: YouTubeFetchOptions = {},
): Promise<TokenResult> {
  const creds = youTubeAppCredentials();
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

/** Refresh-token exchange — the function `youtube-oauth.ts` registers with
 *  `oauth-tokens.ts`'s `registerTokenRefresher('youtube', ...)`. */
export async function refreshWithRefreshToken(
  refreshToken: string,
  opts: YouTubeFetchOptions = {},
): Promise<TokenResult> {
  const creds = youTubeAppCredentials();
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

/** The one outbound call to the YouTube Data API v3 (`www.googleapis.com/youtube/v3`), Bearer-
 *  authenticated. Stateless per call — the access token is a parameter, never retained (port
 *  invariant 2, types.ts's header). */
async function callDataApi<T>(
  accessToken: string,
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number },
  opts: YouTubeFetchOptions = {},
): Promise<{ status: number; body: T | undefined }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? config.social.direct.youtube.readTimeoutMs,
  );
  let res: Response;
  try {
    res = await fetchImpl(`${config.social.direct.youtube.apiBaseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SocialPublisherError(
      "publisher_unreachable",
      `YouTube did not answer ${init.method} ${path}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new SocialPublisherError(
      "publisher_http_error",
      `YouTube answered HTTP ${res.status} for ${init.method} ${path}`,
      res.status,
    );
  }
  const text = await res.text();
  if (!text) return { status: res.status, body: undefined };
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch {
    throw new SocialPublisherError("publisher_http_error", `YouTube returned non-JSON for ${init.method} ${path}`, res.status);
  }
}

export interface ResumableUploadMetadata {
  title: string;
  description?: string;
  /** Defaults to `private` — see this file's header on the forced-private lock. Never send `public`
   *  from this driver unless a future pass deliberately decides to (the composer/settings plumbing
   *  to make that a real per-post choice does not exist yet — `uploadMedia`'s own signature carries
   *  no metadata field beyond `{filename, contentType, bytes}`, a named, load-bearing gap; see
   *  `direct.ts`'s header for the full reasoning). */
  privacyStatus?: "private" | "unlisted" | "public";
}

export interface InitiatedUpload {
  /** The session URI Google returns in the `Location` response header — PUT the raw bytes here. */
  uploadUrl: string;
}

/** Step 1 of Google's resumable-upload protocol (dossier §6, YouTube Data API v3 `videos.insert`):
 *  POST the video's metadata (no bytes yet), get back a session URL in the `Location` header.
 *  ⚠UNVERIFIED end to end (dossier names no live test) — reasoned from Google's general resumable-
 *  upload doc, which every Google API sharing this protocol (Drive, Photos, YouTube) follows
 *  identically. */
export async function initiateResumableUpload(
  accessToken: string,
  metadata: ResumableUploadMetadata,
  contentLength: number,
  contentType: string,
  opts: YouTubeFetchOptions = {},
): Promise<InitiatedUpload> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.social.direct.youtube.readTimeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${config.social.direct.youtube.uploadUrl}${YOUTUBE_ROUTES.uploadInitiate}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(contentLength),
        "X-Upload-Content-Type": contentType,
      },
      body: JSON.stringify({
        snippet: { title: metadata.title, description: metadata.description ?? "" },
        status: { privacyStatus: metadata.privacyStatus ?? "private" },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new SocialPublisherError(
      "publisher_unreachable",
      `YouTube resumable-upload initiate did not complete: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new SocialPublisherError("publisher_http_error", `YouTube resumable-upload initiate answered HTTP ${res.status}`, res.status);
  }
  const uploadUrl = res.headers.get("location");
  if (!uploadUrl) {
    // Accepted but no session URL anywhere this client knows to look — ambiguous, refused loudly,
    // never retried here (design §11's "no auto-retry of ambiguous publish failures", the same rule
    // `linkedin-client.ts#publishOrganizationPost` and `postiz.ts#schedulePost` both enforce).
    throw new SocialPublisherError(
      "publisher_http_error",
      "YouTube accepted the resumable-upload initiate but returned no session URL in the `Location` header",
    );
  }
  return { uploadUrl };
}

/** Step 2: PUT the raw bytes to the session URL from step 1. A single-shot PUT of the WHOLE file —
 *  Google's resumable protocol permits uploading the entire file in one request (it exists for
 *  resumability/chunking, which this driver does not need for the file sizes `dispatch.ts` already
 *  resolves into memory before calling `uploadMedia`) — so no `Content-Range` header is sent; a
 *  single complete-body PUT is itself a valid, complete upload per the protocol. Returns the created
 *  Video resource's `id` — YouTube's own analogue of `providerPostId`. */
export async function uploadVideoBytes(
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: string,
  opts: YouTubeFetchOptions = {},
): Promise<{ videoId: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.social.direct.youtube.uploadTimeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
      body: bytes as unknown as BodyInit,
      signal: controller.signal,
    });
  } catch (err) {
    throw new SocialPublisherError("publisher_unreachable", `YouTube video PUT did not complete: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new SocialPublisherError("publisher_http_error", `YouTube video PUT answered HTTP ${res.status}`, res.status);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new SocialPublisherError("publisher_http_error", "YouTube video PUT returned non-JSON", res.status);
  }
  const videoId = str(asRecord(parsed).id);
  if (!videoId) {
    throw new SocialPublisherError(
      "publisher_http_error",
      "YouTube accepted the video upload but returned no `id` in the response body — outcome AMBIGUOUS, not retried (design §11)",
    );
  }
  return { videoId };
}

/** The comment READ — `commentThreads.list` (dossier §6.2 item (b), needs `youtube.force-ssl`).
 *  `since` is applied CLIENT-SIDE: ⚠UNVERIFIED whether this endpoint accepts a server-side time
 *  filter (Google's docs name no `publishedAfter` parameter for `commentThreads.list`), the same
 *  tolerant discipline `linkedin-client.ts#getPostComments` uses for its own unverified envelope. */
export async function listVideoCommentThreads(
  accessToken: string,
  videoId: string,
  since: Date,
  opts: YouTubeFetchOptions = {},
): Promise<InboxItem[]> {
  const res = await callDataApi<unknown>(accessToken, YOUTUBE_ROUTES.commentThreads(videoId), { method: "GET" }, opts);
  return normalizeCommentThreads(res.body, videoId, since);
}

/** ⚠UNVERIFIED against a live app — reasoned from Google's documented `commentThreads` resource
 *  shape (`items[].snippet.topLevelComment.snippet.{textDisplay,authorDisplayName,publishedAt}`).
 *  Absent fields stay absent — never defaulted, matching every other normalizer in this module
 *  (`postiz.ts`'s own "unknown is not zero" doctrine). A row this client cannot key (no comment
 *  thread id) is skipped, never guessed at. */
export function normalizeCommentThreads(raw: unknown, videoId: string, since: Date): InboxItem[] {
  const rec = asRecord(raw);
  const rows = Array.isArray(rec.items) ? rec.items as unknown[] : [];
  const out: InboxItem[] = [];
  for (const r of rows) {
    const item = asRecord(r);
    const id = str(item.id);
    if (!id) continue;
    const topLevel = asRecord(asRecord(item.snippet).topLevelComment);
    const snippet = asRecord(topLevel.snippet);
    const postedAt = str(snippet.publishedAt);
    if (postedAt && new Date(postedAt) < since) continue;
    out.push({
      externalId: id,
      externalThreadId: videoId,
      kind: "comment",
      // YouTube DOES inline a display name (unlike LinkedIn's bare actor URN) — `authorDisplayName`
      // is part of the documented `commentThreads` snippet shape.
      authorHandle: str(snippet.authorChannelId && asRecord(snippet.authorChannelId).value),
      authorName: str(snippet.authorDisplayName),
      body: str(snippet.textDisplay) ?? "",
      postedAt: postedAt ?? since.toISOString(),
    });
  }
  return out;
}
