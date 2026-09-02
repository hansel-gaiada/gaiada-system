// GHT-2 (docs/blueprints/github-tenant-scope-ruling.md §3/§9) — the data behind
// `GET /api/:t/github/org-status`. Sibling to github-org-tenant.ts (GHT-1) and
// github-repos.controller.ts (GH-08), for the same reason those two stay OUTSIDE `core/github/`:
// this file only READS `integration_connections` (via integrations.service.ts) and two core
// tables it already has RLS reach to — it mints no token, calls no GitHub API, and has no reason
// to sit inside GH-01/02's owned egress surface (`core/github/*.ts`, whose ONLY approved egress
// file is `http-client.ts` — see `core/github/egress-inventory.test.ts`).
//
// ── WHY THIS EXISTS (the user problem, not just the mechanism) ─────────────────────────────────
// The Connections tab shows GitHub as "unconfigured" because the one `owner_kind='user'` GitHub
// row belongs to the shared ERP identity (`web@gaiada.com`), so `owner=me` correctly returns
// nothing for everyone else (ruling §1/§8 — that behaviour is CORRECT and stays). The org's own
// App health has no surface of its own. This module is that surface: the two `owner_kind=
// 'github_app'` rows (`erp`, `agents`), resolved through GHT-1's org tenant so the same answer
// comes back from anywhere in the org-owning company's root tree.
//
// ── HARD RULE: NO TOKEN OR CREDENTIAL MATERIAL, EVER ────────────────────────────────────────────
// Every field below is drawn from `ConnectionResponse` (integrations.service.ts's ONLY response
// shape, ciphertext columns structurally absent) or from `GithubAppDef` (apps.ts — static,
// non-secret role facts). `hasToken`/`hasRefreshToken` are booleans, never the underlying
// ciphertext or its column names. `meta.appId`/`meta.installationId` are deliberately NOT
// forwarded here — they are non-secret per apps.ts's own comment, but this endpoint's contract is
// "app slug / external_account / health", not "dump connection meta", so only `meta.appSlug` is
// projected out (falling back to the static slug if a row predates that meta key).
//
// ── "REACHABILITY" IS HONEST ABOUT WHAT IT PROVES (spec instruction, ruling §9) ─────────────────
// This endpoint does NOT call the GitHub API to prove the installation is live — doing that on
// every page load would burn GitHub rate limit for a status chip nobody is actively debugging.
// Instead `sync` reports LAST-KNOWN facts already sitting in tables this org tenant owns:
//   - `lastRepoSyncAt`   — MAX(github_repos.last_synced_at) for the org tenant (GH-06's crawl/
//                          reconcile sweep stamps this on every successful sync).
//   - `lastWebhookReceivedAt` / `lastWebhookErrorClass` — the most recent
//                          `github_webhook_deliveries` row's timestamp, and — only when that row
//                          is `status='failed'` — a short CLASS derived from its `error` column
//                          (the text up to the first colon/newline, capped at 60 chars), never the
//                          full stored error text. GitHub webhook handler errors are operational
//                          (parse/DB errors), never token material, but "class not raw message" is
//                          the same discipline `wsux12-security-gate.test.ts` holds every other
//                          surface to, applied here even though this column was never designed to
//                          carry secrets.
// `sync.asOf` is stamped read-time and labelled as such in this file's own doc comment: it is
// "when this row was read", never "when a live check ran". A status endpoint that LOOKS like it
// verified something it did not is worse than one that admits what it knows (ticket instruction,
// citing the estate's own alerting-stack incident) — this shape is the corrective for that trap.
import { withTenants } from "../db";
import { GITHUB_APP_ROLES, GITHUB_APPS, githubConnectionOwnerId, type GithubAppRole } from "./github/apps";
import { listConnections } from "./integrations.service";
import { githubOrgMeta } from "./github-org-tenant";

export interface GithubAppStatus {
  role: GithubAppRole;
  /** Human-readable bot identity ("gaiada-erp[bot]"'s slug) — never the numeric app_id/installation_id. */
  slug: string;
  readOnly: boolean;
  /** Whether a credential row has ever been sealed for this role at all. */
  configured: boolean;
  externalAccount: string | null;
  /** `integration_connections.status` — unconfigured|pending|linked|error|revoked. */
  status: string;
  hasToken: boolean;
  tokenExpiresAt: string | null;
}

export interface GithubSyncFacts {
  /** When THIS response was assembled — not a live GitHub probe. See file header. */
  asOf: string;
  lastRepoSyncAt: string | null;
  lastWebhookReceivedAt: string | null;
  /** Only set when the most recent webhook delivery FAILED; a short class, never the raw error text. */
  lastWebhookErrorClass: string | null;
}

export interface GithubOrgStatus {
  org: { login: string; tenantId: string; tenantName: string | null };
  apps: GithubAppStatus[];
  sync: GithubSyncFacts;
}

async function appStatus(orgTenantId: string, role: GithubAppRole): Promise<GithubAppStatus> {
  const def = GITHUB_APPS[role];
  const ownerId = githubConnectionOwnerId(role);
  // Same lookup credential-store.ts's loadAppCredential uses — but through listConnections, which
  // already returns the masked ConnectionResponse shape, so there is no plaintext-yielding call
  // anywhere on this path (readAccessToken is never imported here).
  const rows = await listConnections(orgTenantId, { ownerKind: "github_app", ownerId, provider: "github" });
  const conn = rows[0];
  if (!conn) {
    return {
      role, slug: def.slug, readOnly: def.readOnly, configured: false,
      externalAccount: null, status: "unconfigured", hasToken: false, tokenExpiresAt: null,
    };
  }
  const slug = typeof conn.meta.appSlug === "string" && conn.meta.appSlug ? conn.meta.appSlug : def.slug;
  return {
    role, slug, readOnly: def.readOnly, configured: true,
    externalAccount: conn.externalAccount, status: conn.status,
    hasToken: conn.hasToken, tokenExpiresAt: conn.tokenExpiresAt,
  };
}

/** First clause of a stored error message, capped short — a CLASS, never the full text (see file
 *  header). `null` in, `null` out; an empty/whitespace-only error also reports as no class. */
function errorClass(error: string | null): string | null {
  if (!error) return null;
  const clause = error.split(/[:\n]/)[0]?.trim();
  if (!clause) return null;
  return clause.length > 60 ? `${clause.slice(0, 60)}…` : clause;
}

async function syncFacts(orgTenantId: string): Promise<GithubSyncFacts> {
  // Both tables carry FORCE RLS with a plain tenant_isolation policy (github_repos: migration
  // 202608310735; github_webhook_deliveries: 202608311145) — withTenants([orgTenantId]) is
  // required for either to return a row, exactly like every other org-tenant-scoped read in this
  // BFF surface (github-repos.controller.ts).
  const { repoSync, webhook } = await withTenants([orgTenantId], async (c) => {
    const [repoRow, webhookRow] = await Promise.all([
      c.query<{ max: string | null }>(
        `SELECT MAX(last_synced_at) AS max FROM github_repos WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [orgTenantId],
      ),
      c.query<{ received_at: string; status: string; error: string | null }>(
        `SELECT received_at, status, error FROM github_webhook_deliveries
          WHERE tenant_id = $1 ORDER BY received_at DESC LIMIT 1`,
        [orgTenantId],
      ),
    ]);
    return { repoSync: repoRow.rows[0]?.max ?? null, webhook: webhookRow.rows[0] ?? null };
  });
  return {
    asOf: new Date().toISOString(),
    lastRepoSyncAt: repoSync,
    lastWebhookReceivedAt: webhook?.received_at ?? null,
    lastWebhookErrorClass: webhook?.status === "failed" ? errorClass(webhook.error) : null,
  };
}

/** Assembles the full org-status response. Caller (the controller) is responsible for resolving
 *  and authorizing the org tenant FIRST — same order as every other route in this BFF surface —
 *  this function trusts `orgTenantId` is already the resolved, authorized org tenant. */
export async function getGithubOrgStatus(orgTenantId: string): Promise<GithubOrgStatus> {
  const [org, apps, sync] = await Promise.all([
    githubOrgMeta(orgTenantId),
    Promise.all(GITHUB_APP_ROLES.map((role) => appStatus(orgTenantId, role))),
    syncFacts(orgTenantId),
  ]);
  return { org, apps, sync };
}
