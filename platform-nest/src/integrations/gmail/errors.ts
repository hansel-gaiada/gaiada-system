// MAIL-16D — the Gmail seam's error taxonomy (design §8C/plan row: "unauthorized/revoked,
// rate-limited w/ retry-after, not-found"). Mirrors the shared-base-class shape core's
// google-oauth/errors.ts already established (SM-25a) — a family that CANNOT be thrown without a
// status + stable `code`, so a new error type is not expressible without deciding both.
//
// UNAUTHORIZED vs REVOKED are deliberately two classes, not one with a flag: `GmailUnauthorizedError`
// is "no usable credential was presented to this call at all" (a caller bug — MAIL-16 should never
// construct a client without a token); `GmailRevokedError` is "a credential WAS presented but the
// grant behind it is gone" (the user revoked access in their Google account, or — Testing-mode app
// note carried from core/google-oauth/oauth.ts — a short-lived refresh token expired). The two
// demand different UI treatment (MAIL-17, out of scope here): a caller bug is not user-actionable;
// a revoked grant means "reconnect Gmail".
export abstract class GmailClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class GmailUnauthorizedError extends GmailClientError {
  constructor(detail?: Record<string, unknown>) {
    super(401, "gmail_unauthorized", "no valid Gmail credential was presented for this call", detail);
  }
}

export class GmailRevokedError extends GmailClientError {
  constructor(detail?: Record<string, unknown>) {
    super(403, "gmail_revoked", "the Gmail grant behind this connection has been revoked or expired", detail);
  }
}

/** 429. `retryAfterSeconds` is REQUIRED, not optional — a rate-limit error a caller cannot back off
 *  from correctly is worse than no rate-limit error at all (design §8C: "quota/policy specifics are
 *  VERIFY-AT-BUILD-TIME" — this seam still commits to always carrying a number so MAIL-16's live
 *  adapter has a contract to fill in, real quota mechanics notwithstanding). */
export class GmailRateLimitedError extends GmailClientError {
  constructor(
    readonly retryAfterSeconds: number,
    detail?: Record<string, unknown>,
  ) {
    super(429, "gmail_rate_limited", `Gmail rate limit hit — retry after ${retryAfterSeconds}s`, {
      retryAfterSeconds,
      ...detail,
    });
  }
}

export class GmailNotFoundError extends GmailClientError {
  constructor(kind: "thread" | "message", id: string) {
    super(404, "gmail_not_found", `${kind} not found: ${id}`, { kind, id });
  }
}
