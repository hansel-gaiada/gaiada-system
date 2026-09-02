// GH-01/GH-02 — THE ONE FILE in src/core/github/ that originates an outbound network call (see
// egress-inventory.test.ts, which pins this by exact filename — same discipline as
// core/google-oauth/token-endpoint-client.ts). Everything else in this directory (jwt.ts,
// token-cache.ts, rate-limiter.ts, credential-store.ts, apps.ts) is pure or DB-only.
//
// Two responsibilities live here on purpose, not split further: (1) the installation-token exchange
// (§2.3's `POST /app/installations/{id}/access_tokens`) and (2) the general authenticated GitHub API
// request wrapper (§4.7's rate-limited, fairness-queued, error-mapped client). Splitting them into
// two files would only move the fetch call, not eliminate a second egress point to track.
//
// SECRET DISCIPLINE: no function here logs a JWT, a PEM, an installation token, or an Authorization
// header value. Error paths surface the HTTP status and GitHub's own (already-public-shaped)
// `message`/`documentation_url` fields only — see errors.ts's per-class notes.
import { mintAppJwt } from "./jwt";
import { InstallationToken } from "./token-cache";
import { GithubRetryableSignal, InstallationRateLimiter, type RateLimitSnapshot } from "./rate-limiter";
import { GITHUB_APPS, type GithubAppRole } from "./apps";
import { GithubApiError, GithubReadOnlyRoleError, GithubTokenExchangeError } from "./errors";

/** Injectable for tests, matching this repo's established `fetchImpl` convention
 *  (core/google-oauth/token-endpoint-client.ts, modules/search's vendor drivers). Defaults to global
 *  fetch — the real path (real sockets, real header serialization) is what runs unless a test opts
 *  into a fake. */
export type FetchImpl = typeof fetch;

const USER_AGENT = "gaiada-erp";
const API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15_000;

/** §2.3: exchange a freshly-minted App JWT for a 1-hour installation token. This is the ONLY
 *  function in the codebase that may call this GitHub endpoint (§4.1's single chokepoint) — it is
 *  invoked exclusively from an `InstallationTokenCache`'s `mint` callback (github-app.service.ts),
 *  never directly by a request path, so a token is always served from the cache. */
export async function mintInstallationToken(
  role: GithubAppRole,
  appId: string,
  privateKeyPem: string,
  installationId: string,
  fetchImpl: FetchImpl = fetch,
): Promise<InstallationToken> {
  const jwt = mintAppJwt({ appId, privateKeyPem });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
  } catch {
    // Network/timeout failure — never interpolate `err` (it can carry the request URL/headers in
    // some fetch implementations' error causes; the URL here is fixed and non-secret anyway, but
    // the discipline is "never interpolate a raw fetch error", full stop, matching
    // token-endpoint-client.ts's identical rule).
    throw new GithubTokenExchangeError(role, 0, "network_error_or_timeout");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let message: string | undefined;
    try {
      message = (JSON.parse(text) as { message?: string }).message;
    } catch {
      /* non-JSON body — leave message undefined, status alone is still reported */
    }
    throw new GithubTokenExchangeError(role, res.status, message);
  }
  const body = JSON.parse(text) as { token: string; expires_at: string; permissions?: Record<string, string> };
  return { token: body.token, expiresAt: body.expires_at, permissions: body.permissions ?? {} };
}

function parseRateLimitHeaders(headers: Headers): Partial<RateLimitSnapshot> {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  const out: Partial<RateLimitSnapshot> = {};
  if (limit !== null && Number.isFinite(Number(limit))) out.limit = Number(limit);
  if (remaining !== null && Number.isFinite(Number(remaining))) out.remaining = Number(remaining);
  if (reset !== null && Number.isFinite(Number(reset))) out.resetAtMs = Number(reset) * 1000;
  return out;
}

/** Retry-After can be delta-seconds (GitHub's documented form for both the primary and secondary
 *  rate limit) or, per RFC 7231, an HTTP-date — handled defensively even though GitHub's own docs
 *  only promise the former, because trusting an unvalidated header format to always be a small
 *  integer is exactly the kind of assumption that turns into `NaN` -> `setTimeout(NaN)` -> "wait
 *  forever" the one time an upstream changes its mind. */
function retryAfterMs(headers: Headers, clock: () => number): number {
  const raw = headers.get("retry-after");
  if (!raw) return 60_000; // GitHub gives no header on some secondary-limit 403s; a bounded default
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - clock());
  return 60_000;
}

export interface GithubRequest {
  role: GithubAppRole;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path only, e.g. `/repos/gaiadabali/foo/pulls` — the host is fixed to api.github.com. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface GithubResponse<T> {
  data: T;
  status: number;
  rateLimit: RateLimitSnapshot;
}

/** Everything the request wrapper needs, injected so this class holds no global state and every
 *  dependency is fakeable in a test (github-app.service.ts wires the real ones). */
export interface GithubInstallationClientDeps {
  getToken: () => Promise<string>;
  onAuthExpired: () => void;
  limiter: InstallationRateLimiter;
  fetchImpl?: FetchImpl;
  clock?: () => number;
}

/** The rate-limited, fairness-queued, error-mapped GitHub API client for ONE installation. One
 *  instance per role (github-app.service.ts owns exactly two — erp and agents — matching "one shared
 *  bucket per installation", §4.7: two installations, two independent buckets). */
export class GithubInstallationClient {
  private readonly fetchImpl: FetchImpl;
  private readonly clock: () => number;

  constructor(private readonly deps: GithubInstallationClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.clock = deps.clock ?? Date.now;
  }

  /** `actingUserId` is the ERP user whose fairness slot this call occupies (§4.7) — NOT a GitHub
   *  identity; every call still authenticates as the App's installation token regardless of who
   *  requested it (§1: API actions collapse to the bot by design; the ERP ledger, not GitHub, is
   *  what attributes this to a human — §4.3/§4.4, out of this ticket's scope). */
  async request<T>(actingUserId: string, req: GithubRequest): Promise<GithubResponse<T>> {
    const def = GITHUB_APPS[req.role];
    const method = req.method ?? "GET";
    if (def.readOnly && method !== "GET") {
      // Refused HERE, before any egress at all — §2.2's structural read-only guarantee. A
      // prompt-injected caller reaching this class through the `agents` role can never even attempt
      // a write; there is no GitHub response to have gotten wrong.
      throw new GithubReadOnlyRoleError(req.role, method, req.path);
    }
    return this.deps.limiter.schedule(actingUserId, (attempt) => this.dispatch<T>(req, method, attempt));
  }

  private async dispatch<T>(req: GithubRequest, method: string, attempt: number): Promise<GithubResponse<T>> {
    const token = await this.deps.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com${req.path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": USER_AGENT,
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new GithubApiError(`${method} ${req.path}`, 0, "network_error_or_timeout");
    }
    clearTimeout(timer);

    const snapshot = parseRateLimitHeaders(res.headers);
    this.deps.limiter.observe(snapshot);

    if (res.status === 401) {
      // The cached token stopped working mid-life (installation suspended, App uninstalled, key
      // rotated out from under us) — invalidate so the NEXT attempt (if any is left) mints fresh
      // rather than retrying the exact same dead token, then treat this as retryable once: a mid-
      // flight rotation is transient, but only ever ONE extra attempt (attempt<1) so a genuinely
      // revoked installation still surfaces as a real error instead of looping.
      this.deps.onAuthExpired();
      if (attempt < 1) throw new GithubRetryableSignal(`${method} ${req.path}`, 0, snapshot.remaining ?? 0);
      throw new GithubApiError(`${method} ${req.path}`, 401, await safeMessage(res));
    }

    if (res.status === 403 || res.status === 429) {
      // §4.7: absorbed by the fairness queue's backoff, not surfaced to the caller unless retries
      // are exhausted (rate-limiter.ts turns an exhausted signal into a rejection with THIS signal,
      // which github-app.service.ts's caller maps to GithubRateLimitedError — see that file).
      throw new GithubRetryableSignal(
        `${method} ${req.path}`,
        retryAfterMs(res.headers, this.clock),
        snapshot.remaining ?? 0,
      );
    }

    if (!res.ok) {
      throw new GithubApiError(`${method} ${req.path}`, res.status, await safeMessage(res));
    }

    const text = await res.text();
    const data = (text ? JSON.parse(text) : undefined) as T;
    return { data, status: res.status, rateLimit: snapshot as RateLimitSnapshot };
  }
}

async function safeMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message;
  } catch {
    return undefined;
  }
}

// The API host is fixed, not configurable — GitHub has exactly one host, so unlike the provision
// seam (config.provision.baseUrl) there is no "no default endpoint" hazard: nothing here could ever
// default to the wrong deployment's URL. app_id/installation_id/PEM all arrive as arguments from the
// caller (apps.ts / credential-store.ts), which is why this file has no `config` import at all.
export const GITHUB_API_BASE = "https://api.github.com";
