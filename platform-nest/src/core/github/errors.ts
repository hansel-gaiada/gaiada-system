// GH-02 — the GitHub-surface error family, mirroring core/google-oauth/errors.ts's OWN mirror of the
// SM-53/SM-57 precedent (see that file's header for the two prior incidents this shape prevents): a
// plain `Error` thrown from a service layer is invisible to `HttpErrorFilter` (`@Catch(HttpException)`)
// and surfaces as a MESSAGE-LESS 500 via LastResortExceptionFilter — losing exactly the human-
// actionable content the refusal existed to deliver. Every error here descends from ONE base class
// carrying its own `status`+`code`, mapped by ONE filter (`github-error.filter.ts`) that is added the
// moment a new subclass is introduced — there is no per-error branch to forget to update.
//
// ⚠ THE TRAP THIS FILE IS BUILT TO AVOID (per this repo's own documented incident, http-error.filter.ts
// lines 44-49): a thrower that sets `{ error: "<token>" }` instead of `{ message: "<token>" }` on a
// Nest HttpException gets silently renamed to the constructor's generic string by HttpErrorFilter,
// because that filter reads `.message`, never `.error`. This family sidesteps the trap structurally by
// not using HttpException at all — `github-error.filter.ts` reads `exception.message` directly (the
// param passed to `super(message)` below), so there is no `{error: ...}` object literal anywhere in
// this file for the trap to reoccur in.
export abstract class GithubSurfaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Non-secret detail only — see the SECRET DISCIPLINE note on every constructor below. Never a
     *  token, never a PEM, never a raw Authorization header. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** FAIL-CLOSED: no role/app is configured (missing app_id/installation_id, §2.2) or no credential is
 *  sealed in the vault yet (§2.3) — a deployment state, not a caller error, mirroring
 *  GoogleOAuthNotConfiguredError's 503 exactly. */
export class GithubNotConfiguredError extends GithubSurfaceError {
  constructor(role: string, reason: "app_not_configured" | "credential_not_sealed" | "vault_key_missing") {
    super(
      503,
      "github_not_configured",
      `the GitHub App for role '${role}' is not configured (${reason}) — see docs/blueprints/github-integration-foundation.md §2.2/§2.3`,
      { role, reason },
    );
  }
}

/** The installation-token exchange (`POST /app/installations/{id}/access_tokens`) itself failed —
 *  distinct from a per-call API refusal because this one means NOTHING downstream could even be
 *  attempted with a fresh token. 502: the failure crossed a network boundary to GitHub, so
 *  attributing it to our caller would be a lie (same reasoning as GoogleTokenEndpointError).
 *
 *  SECRET DISCIPLINE: `detail` never carries the JWT, the PEM, or the response body verbatim — only
 *  the HTTP status and a truncated, already-public-shaped GitHub error `message` field (GitHub's own
 *  4xx bodies for this endpoint are `{message, documentation_url}`, never an echo of the request). */
export class GithubTokenExchangeError extends GithubSurfaceError {
  constructor(role: string, httpStatus: number, githubMessage?: string) {
    super(
      502,
      "github_token_exchange_failed",
      `GitHub refused the installation-token exchange for role '${role}' (HTTP ${httpStatus})`,
      { role, httpStatus, ...(githubMessage ? { githubMessage: githubMessage.slice(0, 300) } : {}) },
    );
  }
}

/** A GitHub API call was refused for a reason OTHER than rate limiting (that is
 *  GithubRateLimitedError below) — auth revoked mid-flight, a 404/422 on the target resource, a 5xx
 *  from GitHub itself. 502 for anything GitHub-side (5xx or an ambiguous refusal); the ORIGINAL
 *  status is always preserved in `detail.httpStatus` so a caller that cares can still branch on it
 *  without this filter having to re-derive a client-facing status from GitHub's own code. */
export class GithubApiError extends GithubSurfaceError {
  constructor(operation: string, httpStatus: number, githubMessage?: string) {
    super(
      httpStatus >= 400 && httpStatus < 500 ? httpStatus : 502,
      "github_api_error",
      `GitHub refused '${operation}' (HTTP ${httpStatus}${githubMessage ? `: ${githubMessage.slice(0, 200)}` : ""})`,
      { operation, httpStatus },
    );
  }
}

/** §4.7 — the shared per-installation bucket is exhausted (secondary rate limit 403, or a plain 429),
 *  surfaced ONLY after the fairness queue's own backoff/retry budget is exhausted (rate-limiter.ts) —
 *  a caller seeing this means the queue already tried to absorb it. 429, not 502: this is a real,
 *  well-understood client-facing condition ("come back later"), not an upstream fault. */
export class GithubRateLimitedError extends GithubSurfaceError {
  constructor(operation: string, retryAfterMs: number, remaining: number) {
    super(
      429,
      "github_rate_limited",
      `GitHub's shared installation rate limit is exhausted for '${operation}' — retry after ${Math.ceil(retryAfterMs / 1000)}s`,
      { operation, retryAfterMs, remaining },
    );
  }
}

/** §2.2's structural read-only assertion: something tried to make a write-shaped call (POST/PATCH/
 *  PUT/DELETE) through the `agents` role. This must never reach GitHub at all — it is refused HERE,
 *  before any egress, which is the whole point of a separate read-only App (a prompt-injected agent
 *  must not be able to write). 403: the caller is known (which role) and refused. */
export class GithubReadOnlyRoleError extends GithubSurfaceError {
  constructor(role: string, method: string, path: string) {
    super(
      403,
      "github_read_only_role",
      `role '${role}' is read-only and cannot perform ${method} ${path}`,
      { role, method },
    );
  }
}
