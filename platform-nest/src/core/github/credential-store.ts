// GH-01 §2.3 — "The App private key (PEM) is sealed via the existing secret-box.ts into
// integration_connections ..., provider='github'. Do NOT invent a new storage mechanism." This file
// is a thin, provider-scoped projection over integrations.service.ts — same shape as
// claude-seats.service.ts's own comment describes for provider='claude': NO new table, NO new
// secret path, every read/write delegates to the existing vault.
//
// ── WHERE THE PEM LIVES, AND WHY ────────────────────────────────────────────────────────────────
// `integration_connections` has exactly two secret columns: access_token_enc / refresh_token_enc.
// A GitHub App has no OAuth access/refresh token of its own — its one long-lived credential IS the
// private key, and everything else (the installation token) is minted at runtime and never
// persisted (§4.1, token-cache.ts). Reusing `access_token_enc` for the PEM is therefore not a
// repurposing so much as the natural fit: "the credential this row seals" is exactly what that
// column has always meant, and it inherits the vault's existing guarantees for free —
// AES-256-GCM at rest (secret-box.ts), fail-closed without INTEGRATION_TOKEN_KEY, and the
// structural non-exposure that `toConnectionResponse()` already enforces (hasToken:boolean only).
//
// ── owner_kind='github_app' — RULING CORRECTED 2026-08-31 (§2.3(b)) ────────────────────────────
// §2.3 originally said owner_kind='company', but 0033's `owner_kind='company' -> owner_id = the
// company's id` is a documented invariant, and neither existing owner_kind can honestly describe a
// per-App credential row shared by two Apps under one tenant/provider (the table's
// `UNIQUE (tenant_id, owner_kind, owner_id, provider)` collides if both rows use
// `owner_kind='company', owner_id=tenantId`). A first fix tried a synthetic STRING owner_id
// (`github-app:<slug>`) and did not compile against the column's `uuid` type — proven live
// (credential-store.test.ts 8/8 failures, one repo-sync.db.test.ts case). The corrected fix
// (migration `202608311000_integration_connections_github_app_owner_kind.sql`) adds a THIRD,
// honestly-named discriminator instead: `owner_kind='github_app'`, `owner_id` = a deterministic
// UUIDv5 derived from the App slug (`githubConnectionOwnerId()`, apps.ts), with the human-readable
// slug kept in `meta.appSlug` for legibility. This keeps both App rows entirely outside the generic
// HTTP API's WRITE path (`github_app` is deliberately excluded from
// `CLIENT_CREATABLE_OWNER_KINDS` in integrations.controller.ts) — and, as things stand, outside its
// READ path too: the GET list endpoint's `owner=` selector has no `github_app` branch, so these
// rows are unreachable via the generic connections HTTP API in either direction today, only via
// this file's own service-layer calls. Giving each App role its own row under the same UNIQUE
// constraint is a real implementation choice the blueprint left open, not an invented storage
// mechanism: every existing column is reused as-is, and the CHECK widening is the only schema
// change.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import {
  createConnection, listConnections, readAccessToken, setConnectionTokens,
  type ConnectionResponse,
} from "../integrations.service";
import { tokenVaultConfigured } from "../secret-box";
import { GITHUB_APPS, githubConnectionOwnerId, type GithubAppRole } from "./apps";
import { GithubNotConfiguredError } from "./errors";

export interface SealCredentialInput {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  createdBy: string | null;
}

/** Seal (or re-seal, on a key rotation) a role's App credential. UPSERTs via createConnection's
 *  existing idempotency (decision #8) — re-running this for the same role updates the row rather
 *  than duplicating it or erroring, which matters for a real key-rotation runbook. Never returns the
 *  PEM: the response is the same masked `ConnectionResponse` every other connection returns
 *  (`hasToken` only). Throws whatever `encryptSecret()` throws (503) when INTEGRATION_TOKEN_KEY is
 *  unset — fail-closed, exactly like every other token write in this vault. */
export async function sealAppCredential(
  tenantId: string,
  role: GithubAppRole,
  input: SealCredentialInput,
): Promise<ConnectionResponse> {
  const def = GITHUB_APPS[role];
  const created = await createConnection(tenantId, {
    ownerKind: "github_app",
    ownerId: githubConnectionOwnerId(role),
    provider: "github",
    externalAccount: def.slug,
    scopes: def.readOnly ? ["read"] : ["read", "write"],
    meta: {
      appId: input.appId, installationId: input.installationId, role, readOnly: def.readOnly,
      appSlug: def.slug, // human-readable — owner_id itself is now an opaque deterministic uuid
    },
    createdBy: input.createdBy,
  });
  return setConnectionTokens(tenantId, created.id, { accessToken: input.privateKeyPem });
}

export interface LoadedCredential {
  connectionId: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

/** Load a role's sealed PEM for minting (github-app.service.ts's TokenMinter). Returns null when no
 *  credential has been sealed yet — the caller (github-app.service.ts) turns that into
 *  `GithubNotConfiguredError`, not this function, because "not configured" here specifically means
 *  the credential row itself is absent; `loadOrThrow` below is the fail-closed wrapper most callers
 *  actually want. Never logs, never returns anything through an HTTP response mapper — this is the
 *  one path that yields the PEM in plaintext, exactly mirroring `readAccessToken`'s own doc comment
 *  in integrations.service.ts ("deliberately the ONLY exported path that yields plaintext"). */
export async function loadAppCredential(tenantId: string, role: GithubAppRole): Promise<LoadedCredential | null> {
  const ownerId = githubConnectionOwnerId(role);
  const rows = await listConnections(tenantId, { ownerKind: "github_app", ownerId, provider: "github" });
  const conn = rows[0];
  if (!conn || !conn.hasToken) return null;
  const appId = typeof conn.meta.appId === "string" ? conn.meta.appId : "";
  const installationId = typeof conn.meta.installationId === "string" ? conn.meta.installationId : "";
  if (!appId || !installationId) return null; // sealed row exists but is missing required meta — treat as absent
  const pem = await withTenants([tenantId], (c: PoolClient) => readAccessToken(c, conn.id));
  if (!pem) return null;
  return { connectionId: conn.id, appId, installationId, privateKeyPem: pem };
}

/** Fail-closed wrapper: throws `GithubNotConfiguredError` with a specific, diagnosable reason
 *  instead of returning null, for callers (the token minter) that have no sensible fallback. */
export async function loadAppCredentialOrThrow(tenantId: string, role: GithubAppRole): Promise<LoadedCredential> {
  if (!tokenVaultConfigured()) throw new GithubNotConfiguredError(role, "vault_key_missing");
  const cred = await loadAppCredential(tenantId, role);
  if (!cred) throw new GithubNotConfiguredError(role, "credential_not_sealed");
  return cred;
}
