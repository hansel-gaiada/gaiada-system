// GH-01 (docs/blueprints/github-integration-foundation.md §2.2) — the GitHub App registry.
//
// Exactly two roles exist by design (§0 D1/D3, §2.2): `erp` is the write arm platform-nest holds
// ("gaiada-erp[bot]"); `agents` is the READ-ONLY arm mcp-hub holds ("gaiada-agents[bot]"). A third
// App (`gaiadabali-deploy`) exists on the org but is explicitly NOT platform-nest's concern (§2.2:
// it authenticates delphi/helios's own pull, never minted here) — do not add it here "for
// completeness"; that would be inventing a chokepoint this design deliberately does not own (§4.1:
// "One github provider service in platform-nest. No other service mints or holds an installation
// token" — gaiadabali-deploy's token is never minted by this service at all).
import { v5 as uuidv5 } from "uuid";
import { config } from "../../config";

export type GithubAppRole = "erp" | "agents";

export const GITHUB_APP_ROLES: readonly GithubAppRole[] = ["erp", "agents"];

/** Static facts about a role — NOT the live credential (that is sealed in the vault, see
 *  credential-store.ts) and NOT the app_id/installation_id (those are env-configured per
 *  deployment, see config.githubApps). `readOnly` is asserted structurally by http-client.ts before
 *  every write-shaped request, mirroring scripts/github-app/verify-app.mjs's own read-only check —
 *  the whole reason `agents` is a separate App is that a prompt-injected agent must not be able to
 *  write (§2.2), so this is enforced in code, not merely documented. */
export interface GithubAppDef {
  role: GithubAppRole;
  /** The bot identity this App acts as, per §1 ("gaiada-erp[bot]" / not applicable to agents, which
   *  never writes so never appears as a commit/PR author). Used for admin display only. */
  slug: string;
  readOnly: boolean;
}

export const GITHUB_APPS: Record<GithubAppRole, GithubAppDef> = {
  erp: { role: "erp", slug: "gaiada-erp", readOnly: false },
  agents: { role: "agents", slug: "gaiada-agents", readOnly: true },
};

export interface GithubAppIdentity {
  appId: string;
  installationId: string;
}

/** The non-secret identifiers for a role, from env. Null when either is unset — fail-closed,
 *  callers must not half-configure (an app_id with no installation_id, or vice versa, can mint
 *  nothing usable). */
export function githubAppIdentity(role: GithubAppRole): GithubAppIdentity | null {
  const c = config.githubApps[role];
  if (!c?.appId || !c?.installationId) return null;
  return { appId: c.appId, installationId: c.installationId };
}

// GH-01 §2.3(b) — RULING CORRECTED 2026-08-31 (docs/blueprints/github-integration-foundation.md).
// The first version of `githubConnectionOwnerId()` returned a synthetic STRING (`github-app:<slug>`)
// for a column declared `owner_id uuid NOT NULL` — proven live not to compile
// (credential-store.test.ts 8/8, one repo-sync.db.test.ts case: `invalid input syntax for type uuid`).
//
// Fixed namespace for a deterministic UUIDv5 (RFC 4122 §4.3): `uuidv5(slug, NAMESPACE)` is a pure
// function of the slug, so it is stable across every environment (dev/CI/staging/live) without being
// stored or generated at runtime, and distinct per App slug (SHA-1 over namespace+name) so the two
// rows never collide under `UNIQUE (tenant_id, owner_kind, owner_id, provider)`.
// ⚠ THIS CONSTANT MUST NEVER CHANGE. Changing it changes every derived owner_id, which orphans any
// already-sealed credential row (a new lookup computes a different id and finds nothing) — same
// failure class as renaming a seed-resolved-by-name row (platform-nest/CLAUDE.md "the rename trap").
const GITHUB_APP_OWNER_NAMESPACE = "c7e1667a-c191-4f5c-a0c7-b20187d59928";

/** Owner-id discriminator used to seal/find this role's credential row in `integration_connections`
 *  (owner_kind='github_app', provider='github' — §2.3(b), corrected). A deterministic UUIDv5 derived
 *  from the App slug — NOT the tenant id, NOT a synthetic string — so the two Apps' rows coexist
 *  under the table's `UNIQUE (tenant_id, owner_kind, owner_id, provider)` constraint while owner_id
 *  stays honestly a uuid. `meta.appSlug` (credential-store.ts) carries the human-readable slug this
 *  hides. `owner_kind='github_app'` is deliberately excluded from
 *  `CLIENT_CREATABLE_OWNER_KINDS` (integrations.controller.ts) — these rows are ops-provisioned via
 *  credential-store.ts only. The generic connections HTTP API's GET list endpoint has no
 *  `owner=github_app` selector either, so these rows are currently unreachable through that HTTP
 *  surface in EITHER direction; they are read exclusively through credential-store.ts's own
 *  service-layer calls. */
export function githubConnectionOwnerId(role: GithubAppRole): string {
  return uuidv5(GITHUB_APPS[role].slug, GITHUB_APP_OWNER_NAMESPACE);
}
