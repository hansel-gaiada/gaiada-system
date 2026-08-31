// GH-01/GH-02 §4.1 — the single chokepoint. "One github provider service in platform-nest. No other
// service mints or holds an installation token. No code path returns a token to a caller."
//
// This file is the ONLY place that wires credential-store.ts (the vault) + jwt.ts (mint) +
// token-cache.ts (in-memory-only cache) + rate-limiter.ts (fairness queue) + http-client.ts (the one
// egress point) together into something a caller can actually use. It owns exactly ONE
// InstallationTokenCache + ONE InstallationRateLimiter PER ROLE, module-scoped singletons — matching
// §4.7's "one shared bucket per installation" (two installations => two independent buckets; a bulk
// operation against `erp` cannot starve `agents` traffic, because they are different queues over
// different tokens entirely, not merely different labels on one queue).
import { githubAppIdentity, GITHUB_APP_ROLES, GITHUB_APPS, type GithubAppRole } from "./apps";
import { loadAppCredentialOrThrow, sealAppCredential, type SealCredentialInput } from "./credential-store";
import { GithubNotConfiguredError, GithubRateLimitedError } from "./errors";
import { mintInstallationToken, GithubInstallationClient, type GithubRequest, type GithubResponse } from "./http-client";
import { InstallationRateLimiter, GithubRetryableSignal } from "./rate-limiter";
import { InstallationTokenCache } from "./token-cache";
import type { ConnectionResponse } from "../integrations.service";

interface RoleRuntime {
  cache: InstallationTokenCache;
  limiter: InstallationRateLimiter;
  client: GithubInstallationClient;
}

// Module-scoped by design (§4.1's chokepoint): every call anywhere in the process for a given role
// shares the SAME cache and the SAME queue, which is the entire mechanism that makes the fairness
// guarantee (§4.7) and the never-persisted cache guarantee (§2.3) real instead of aspirational. A
// per-request instance would defeat both.
const runtimes = new Map<string, RoleRuntime>();

/** Test-only reset — a fresh process gets fresh runtimes naturally, but a test file that seals
 *  different credentials under the same tenant across cases needs the cache/queue cleared between
 *  them, or a stale cached token from a previous test's credential would silently keep being used. */
export function resetGithubRuntimesForTest(): void {
  runtimes.clear();
}

function runtimeFor(tenantId: string, role: GithubAppRole): RoleRuntime {
  const key = `${tenantId}:${role}`;
  let rt = runtimes.get(key);
  if (!rt) {
    const cache = new InstallationTokenCache(async () => {
      const identity = githubAppIdentity(role);
      if (!identity) throw new GithubNotConfiguredError(role, "app_not_configured");
      const cred = await loadAppCredentialOrThrow(tenantId, role);
      // The vault row is the source of truth for WHICH installation the sealed key belongs to
      // (cred.installationId), not config — config only supplies the non-secret app_id/
      // installation_id used to VALIDATE that the right credential is configured for this
      // deployment before ever touching the vault. A mismatch between the two would mean the
      // sealed credential was rotated for a different installation than this deployment expects;
      // fail rather than guess which one is authoritative.
      if (cred.appId !== identity.appId || cred.installationId !== identity.installationId) {
        throw new GithubNotConfiguredError(role, "credential_not_sealed");
      }
      return mintInstallationToken(role, cred.appId, cred.privateKeyPem, cred.installationId);
    });
    const limiter = new InstallationRateLimiter();
    const client = new GithubInstallationClient({
      getToken: () => cache.getToken(),
      onAuthExpired: () => cache.invalidate(),
      limiter,
    });
    rt = { cache, limiter, client };
    runtimes.set(key, rt);
  }
  return rt;
}

/** Seal (or rotate) a role's App credential — GH-01's storage half, delegated straight to
 *  credential-store.ts. Exported here too so callers only need ONE import for the whole subsystem. */
export async function sealGithubAppCredential(
  tenantId: string,
  role: GithubAppRole,
  input: SealCredentialInput,
): Promise<ConnectionResponse> {
  const result = await sealAppCredential(tenantId, role, input);
  // A rotation must not leave a stale cached token (minted under the OLD key) silently in use for
  // up to an hour — invalidate this role's cache immediately so the next call mints fresh.
  runtimes.get(`${tenantId}:${role}`)?.cache.invalidate();
  return result;
}

/** Perform one authenticated GitHub API call as `actingUserId`, under role's shared fairness queue.
 *  This is the ONE function every future GH ticket (GH-06 crawl, GH-07 webhook reconcile, GH-10
 *  write arm) should call — it is what makes §4.1's "one chokepoint" true beyond just the token: no
 *  caller anywhere else constructs its own `GithubInstallationClient`.
 *
 *  Retryable failures already absorbed by the queue never reach here as GithubRetryableSignal; if
 *  the queue exhausts its own retry budget, the raw signal is mapped to `GithubRateLimitedError`
 *  HERE (not in rate-limiter.ts, which deliberately does not know about this error family — see that
 *  file's header) so a caller always sees a `GithubSurfaceError`, never the internal queue protocol
 *  type. */
export async function githubRequest<T>(
  tenantId: string,
  role: GithubAppRole,
  actingUserId: string,
  req: Omit<GithubRequest, "role">,
): Promise<GithubResponse<T>> {
  const rt = runtimeFor(tenantId, role);
  try {
    return await rt.client.request<T>(actingUserId, { ...req, role });
  } catch (e) {
    if (e instanceof GithubRetryableSignal) {
      throw new GithubRateLimitedError(e.operation, e.retryAfterMs, e.remaining);
    }
    throw e;
  }
}

// ---- §4.7 admin/info quota surfacing --------------------------------------------------------
export interface GithubRoleAdminDetail {
  role: GithubAppRole;
  slug: string;
  readOnly: boolean;
  configured: boolean;
  appId: string | null;
  installationId: string | null;
  tokenCached: boolean;
  tokenExpiresAt: string | null;
  rateLimit: { limit: number | null; remaining: number | null; resetAt: string | null };
  queueDepth: number;
  activeUsers: number;
}

/** Read-only diagnostic snapshot for BOTH roles, no egress — everything here is already-observed
 *  in-process state (the last x-ratelimit-* headers seen, the cache's own expiry, queue depth), never
 *  a fresh call to GitHub. Feeds `GET /api/admin/github/detail` (admin-systems.controller.ts),
 *  following the same "project the service's own state" pattern as `gatewayConfigFields`/
 *  `hubConfigFields` in that file — the difference being those proxy ANOTHER service's HTTP surface,
 *  while this reads state that already lives in this same process. */
export function githubAdminDetail(tenantId: string): GithubRoleAdminDetail[] {
  return GITHUB_APP_ROLES.map((role) => {
    const identity = githubAppIdentity(role);
    const rt = runtimes.get(`${tenantId}:${role}`);
    const snapshot = rt?.limiter.rateLimitSnapshot() ?? { limit: null, remaining: null, resetAtMs: null };
    const diag = rt?.cache.diagnostics() ?? { hasToken: false, expiresAt: null };
    return {
      role,
      slug: GITHUB_APPS[role].slug,
      readOnly: GITHUB_APPS[role].readOnly,
      configured: identity !== null,
      appId: identity?.appId ?? null,
      installationId: identity?.installationId ?? null,
      tokenCached: diag.hasToken,
      tokenExpiresAt: diag.expiresAt,
      rateLimit: {
        limit: snapshot.limit,
        remaining: snapshot.remaining,
        resetAt: snapshot.resetAtMs !== null ? new Date(snapshot.resetAtMs).toISOString() : null,
      },
      queueDepth: rt?.limiter.queueDepth() ?? 0,
      activeUsers: rt?.limiter.activeUserCount() ?? 0,
    };
  });
}
