// WSUX-14 (ex-P1-08) — F1 connections subsystem: the DB + vault layer (locked decisions #6/#7/#8).
//
// Everything here is tenant-scoped through a SINGLE-LEG withTenants([tenantId], ...) (A1 lint clean —
// one tenant per call, the id already gated by the controller's authorize()). The controller is the
// validation + authz boundary; this file is the persistence + event-emit + credential-sealing core.
//
// THE TOKEN NON-EXPOSURE RULE lives here: toConnectionResponse() is the ONLY shape any caller returns,
// and it NEVER includes access_token_enc / refresh_token_enc — reads surface `hasToken:boolean` +
// metadata only. Tokens are sealed via secret-box.ts and only ever leave the DB into a server-side
// provider call (Phase 2), never into an HTTP response.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { encryptSecret, TOKEN_KEY_VERSION } from "./secret-box";

export const CONNECTION_PROVIDERS = new Set(["github", "google_drive", "claude"]);
export const CONNECTION_OWNER_KINDS = new Set(["user", "company"]);
export const CONNECTION_STATUSES = new Set(["unconfigured", "pending", "linked", "error", "revoked"]);
/** Statuses a client may set directly via PATCH. 'linked' is reserved for the token path (setting it
 *  by hand would falsely imply a stored credential); 'revoked' goes through DELETE (soft revoke). */
export const CLIENT_SETTABLE_STATUSES = new Set(["unconfigured", "pending", "error"]);

export interface ConnectionDbRow {
  id: string;
  tenant_id: string;
  owner_kind: string;
  owner_id: string;
  provider: string;
  external_account: string | null;
  scopes: string[];
  status: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  token_key_version: string | null;
  meta: Record<string, unknown>;
  created_by: string | null;
  origin_site: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** The ONLY response shape. Token ciphertext columns are structurally absent — `hasToken` is the only
 *  signal that a credential exists. Do NOT add access_token_enc/refresh_token_enc here, ever. */
export interface ConnectionResponse {
  id: string;
  tenantId: string;
  ownerKind: string;
  ownerId: string;
  provider: string;
  externalAccount: string | null;
  scopes: string[];
  status: string;
  hasToken: boolean;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
  tokenKeyVersion: string | null;
  meta: Record<string, unknown>;
  createdBy: string | null;
  originSite: string;
  createdAt: string;
  updatedAt: string;
}

export function toConnectionResponse(r: ConnectionDbRow): ConnectionResponse {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    ownerKind: r.owner_kind,
    ownerId: r.owner_id,
    provider: r.provider,
    externalAccount: r.external_account,
    scopes: r.scopes ?? [],
    status: r.status,
    hasToken: !!r.access_token_enc,
    hasRefreshToken: !!r.refresh_token_enc,
    tokenExpiresAt: r.token_expires_at,
    tokenKeyVersion: r.token_key_version,
    meta: r.meta ?? {},
    createdBy: r.created_by,
    originSite: r.origin_site,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLS =
  `id, tenant_id, owner_kind, owner_id, provider, external_account, scopes, status,
   access_token_enc, refresh_token_enc, token_expires_at, token_key_version, meta, created_by,
   origin_site, created_at, updated_at, deleted_at`;

export interface ListFilter {
  ownerKind?: string;
  ownerId?: string;
  provider?: string;
  includeRevoked?: boolean;
}

export async function listConnections(tenantId: string, filter: ListFilter): Promise<ConnectionResponse[]> {
  const clauses: string[] = ["deleted_at IS NULL"];
  const args: unknown[] = [];
  if (filter.ownerKind) clauses.push(`owner_kind = $${args.push(filter.ownerKind)}`);
  if (filter.ownerId) clauses.push(`owner_id = $${args.push(filter.ownerId)}`);
  if (filter.provider) clauses.push(`provider = $${args.push(filter.provider)}`);
  if (!filter.includeRevoked) clauses.push(`status <> 'revoked'`);
  const rows = await withTenants([tenantId], (c) =>
    c.query<ConnectionDbRow>(
      `SELECT ${SELECT_COLS} FROM integration_connections
       WHERE ${clauses.join(" AND ")} ORDER BY provider, created_at DESC`,
      args,
    ),
  );
  return rows.rows.map(toConnectionResponse);
}

/** Load one row (for authz + patch/revoke). Returns the raw DB row (so the controller can read
 *  owner_kind/owner_id for the own-vs-company Cerbos decision); callers map it before responding. */
export async function getConnectionRow(tenantId: string, id: string): Promise<ConnectionDbRow | null> {
  const rows = await withTenants([tenantId], (c) =>
    c.query<ConnectionDbRow>(`SELECT ${SELECT_COLS} FROM integration_connections WHERE id = $1`, [id]),
  );
  return rows.rows[0] ?? null;
}

export interface CreateInput {
  ownerKind: string;
  ownerId: string;
  provider: string;
  externalAccount?: string | null;
  scopes?: string[];
  meta?: Record<string, unknown>;
  createdBy: string | null;
}

/** Create a mapping row — NO tokens in Phase 1 (decision #8). Idempotent on the UNIQUE
 *  (tenant, owner_kind, owner_id, provider): a repeat "create" (incl. re-linking a previously
 *  soft-revoked row) UPSERTs the mapping metadata back to an unconfigured/no-token state rather than
 *  erroring or leaving a stale 'revoked'. Token columns are never written here. */
export async function createConnection(tenantId: string, input: CreateInput): Promise<ConnectionResponse> {
  const id = newId();
  return withTenants([tenantId], async (c) => {
    const res = await c.query<ConnectionDbRow & { inserted: boolean }>(
      `INSERT INTO integration_connections
         (id, tenant_id, owner_kind, owner_id, provider, external_account, scopes, status, meta,
          created_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'unconfigured', $8, $9, $10)
       ON CONFLICT (tenant_id, owner_kind, owner_id, provider) DO UPDATE SET
         external_account = EXCLUDED.external_account,
         scopes = EXCLUDED.scopes,
         meta = EXCLUDED.meta,
         -- re-link a revoked row back to a usable (token-less) state; leave a live row's status as-is
         status = CASE WHEN integration_connections.status = 'revoked' THEN 'unconfigured'
                       ELSE integration_connections.status END,
         deleted_at = NULL,
         updated_at = now()
       RETURNING ${SELECT_COLS}, (xmax = 0) AS inserted`,
      [
        id, tenantId, input.ownerKind, input.ownerId, input.provider,
        input.externalAccount ?? null, input.scopes ?? [], JSON.stringify(input.meta ?? {}),
        input.createdBy, config.originSite,
      ],
    );
    const row = res.rows[0];
    await emitEvent(c, tenantId, "integration_connection", row.id, "integration_connection.created", {
      provider: row.provider, ownerKind: row.owner_kind, deduped: !row.inserted,
    });
    return toConnectionResponse(row);
  });
}

export interface PatchInput {
  externalAccount?: string | null;
  meta?: Record<string, unknown>;
  status?: string;
  scopes?: string[];
}

/** PATCH the mapping metadata (decision #8: externalAccount / meta / status / scopes). Does NOT touch
 *  tokens or set 'linked'/'revoked' (those are the token path / DELETE). COALESCE-style partial update. */
export async function patchConnection(tenantId: string, id: string, input: PatchInput): Promise<ConnectionResponse> {
  const sets: string[] = [];
  const args: unknown[] = [id];
  if (input.externalAccount !== undefined) sets.push(`external_account = $${args.push(input.externalAccount)}`);
  if (input.meta !== undefined) sets.push(`meta = $${args.push(JSON.stringify(input.meta))}`);
  if (input.status !== undefined) sets.push(`status = $${args.push(input.status)}`);
  if (input.scopes !== undefined) sets.push(`scopes = $${args.push(input.scopes)}`);
  sets.push(`updated_at = now()`);
  return withTenants([tenantId], async (c) => {
    const res = await c.query<ConnectionDbRow>(
      `UPDATE integration_connections SET ${sets.join(", ")} WHERE id = $1 RETURNING ${SELECT_COLS}`,
      args,
    );
    const row = res.rows[0];
    await emitEvent(c, tenantId, "integration_connection", row.id, "integration_connection.updated", {
      provider: row.provider,
    });
    return toConnectionResponse(row);
  });
}

/** Soft revoke (decision #8): status='revoked', tokens NULLED, row KEPT (mirrors service-assignment
 *  revoke). A revoked row can be re-linked later via createConnection's upsert. */
export async function revokeConnection(tenantId: string, id: string): Promise<ConnectionResponse> {
  return withTenants([tenantId], async (c) => {
    const res = await c.query<ConnectionDbRow>(
      `UPDATE integration_connections
         SET status = 'revoked', access_token_enc = NULL, refresh_token_enc = NULL,
             token_expires_at = NULL, token_key_version = NULL, updated_at = now()
       WHERE id = $1 RETURNING ${SELECT_COLS}`,
      [id],
    );
    const row = res.rows[0];
    await emitEvent(c, tenantId, "integration_connection", row.id, "integration_connection.revoked", {
      provider: row.provider,
    });
    return toConnectionResponse(row);
  });
}

export interface SetTokensInput {
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  scopes?: string[];
  externalAccount?: string | null;
}

/** VAULT WRITE PATH — seal + store provider credentials (Phase-2 OAuth callbacks + tests). NOT exposed
 *  over the Phase-1 HTTP API. Fail-closed: encryptSecret() throws 503 when INTEGRATION_TOKEN_KEY is
 *  unset, so a token can never land unencrypted. Sets status='linked' and stamps token_key_version.
 *  Returns the masked ConnectionResponse (no plaintext, no ciphertext). */
export async function setConnectionTokens(tenantId: string, id: string, input: SetTokensInput): Promise<ConnectionResponse> {
  // Seal OUTSIDE the txn so a 503 (no key) aborts before any DB write happens.
  const accessEnc = input.accessToken != null ? encryptSecret(input.accessToken) : null;
  const refreshEnc = input.refreshToken != null ? encryptSecret(input.refreshToken) : null;
  return withTenants([tenantId], async (c) => {
    const res = await c.query<ConnectionDbRow>(
      `UPDATE integration_connections SET
         access_token_enc = COALESCE($2, access_token_enc),
         refresh_token_enc = COALESCE($3, refresh_token_enc),
         token_expires_at = $4,
         token_key_version = $5,
         external_account = COALESCE($6, external_account),
         scopes = COALESCE($7, scopes),
         status = 'linked',
         updated_at = now()
       WHERE id = $1 RETURNING ${SELECT_COLS}`,
      [
        id, accessEnc, refreshEnc, input.tokenExpiresAt ?? null, TOKEN_KEY_VERSION,
        input.externalAccount ?? null, input.scopes ?? null,
      ],
    );
    const row = res.rows[0];
    await emitEvent(c, tenantId, "integration_connection", row.id, "integration_connection.linked", {
      provider: row.provider,
    });
    return toConnectionResponse(row);
  });
}

/** Read + decrypt a connection's access token for a server-side provider call (Phase 2). Deliberately
 *  the ONLY exported path that yields plaintext, and it returns the raw string to a Go/Node provider
 *  client — never to an HTTP response mapper. Returns null when the row has no sealed access token. */
export async function readAccessToken(client: PoolClient, id: string): Promise<string | null> {
  const res = await client.query<{ access_token_enc: string | null }>(
    `SELECT access_token_enc FROM integration_connections WHERE id = $1`,
    [id],
  );
  const enc = res.rows[0]?.access_token_enc;
  if (!enc) return null;
  // Imported lazily-safe: decryptSecret is pure + fail-closed. Caller already inside withTenants.
  const { decryptSecret } = await import("./secret-box");
  return decryptSecret(enc);
}
