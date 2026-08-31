// GH-01 §2.3/§4.1 — the in-memory-ONLY installation-token cache.
//
// "Cache the installation token IN MEMORY only, refresh at T-5min. It must NEVER be persisted, never
// logged, never appear in any HTTP response." This class is deliberately the ONLY place a minted
// installation token is held anywhere in the process: a plain object field, never written to
// Postgres, never passed to a logger, and the only accessor (`getToken`) returns the raw string to
// its caller for use in a single outbound Authorization header — never serialized via JSON.stringify
// on `this` (there is intentionally no toJSON()/inspect() override that would make a stray
// `console.log(cache)` safe to write — a bare log of this object serializes as
// `InstallationTokenCache { cached: [Circular *1] }`-shaped junk from Node's default inspector, which
// is a feature here: nothing about this class is meant to look loggable).
//
// Refresh-at-T-5min + in-flight de-duplication: N concurrent callers hitting an expired/near-expired
// token collapse into ONE mint call, not N — otherwise a burst of requests at the exact refresh
// boundary would each independently exchange a new token, which is wasteful against the same shared
// per-installation quota this design is trying to protect (§4.7).
export interface InstallationToken {
  token: string;
  /** ISO-8601, as GitHub returns it (`expires_at`). */
  expiresAt: string;
  permissions: Record<string, string>;
}

export type TokenMinter = () => Promise<InstallationToken>;

const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class InstallationTokenCache {
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly mint: TokenMinter,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Returns a usable token, minting (or waiting on an in-flight mint) only when the cached one is
   *  within REFRESH_SKEW_MS of expiry or absent. */
  async getToken(): Promise<string> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAtMs - REFRESH_SKEW_MS > now) return this.cached.token;
    if (!this.inFlight) {
      this.inFlight = this.mint()
        .then((t) => {
          this.cached = { token: t.token, expiresAtMs: Date.parse(t.expiresAt) };
          return t.token;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  /** Force the next `getToken()` to mint fresh — used after a 401/expired-token response tells us the
   *  cached value is no longer good even though our own clock thought it had time left (clock skew,
   *  or the App's installation was suspended mid-lifetime). Never called from a code path that could
   *  race an in-flight mint into being discarded silently — callers invalidate, then call getToken(). */
  invalidate(): void {
    this.cached = null;
  }

  /** Diagnostic ONLY — an expiry timestamp, never the token itself. Feeds the admin/info quota
   *  surface (§4.7) so an operator can see "a token is cached, expiring at X" without the cache ever
   *  exposing the secret it holds. */
  diagnostics(): { hasToken: boolean; expiresAt: string | null } {
    return { hasToken: this.cached !== null, expiresAt: this.cached ? new Date(this.cached.expiresAtMs).toISOString() : null };
  }
}
