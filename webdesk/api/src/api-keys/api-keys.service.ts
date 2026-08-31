// WSK-05 — API key lifecycle: mint / rotate / revoke, plus the lookup the auth guard uses on
// every request. The plaintext key exists in memory for exactly the duration of a mint/rotate
// call and is returned to the caller ONCE; nothing in this file logs it, and the only thing that
// ever reaches the database is its sha256(+pepper) hash (crypto/api-key-hash.ts).
import { Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { AuditService } from "../audit/audit.service";
import { generateApiKey, hashApiKey } from "../crypto/api-key-hash";
import { config } from "../config";

export type ApiKeyScope = "read" | "write";

export type MintedApiKey = {
  id: string;
  key: string; // plaintext — present ONLY on the object this call returns, never again
  scope: ApiKeyScope;
  envId: string;
  tenantId: string;
  createdAt: string;
};

export type ResolvedApiKey = {
  apiKeyId: string;
  tenantId: string;
  envId: string;
  siteId: string;
  envName: string;
  scope: ApiKeyScope;
};

async function loadEnvironment(client: PoolClient, tenantId: string, envId: string) {
  const { rows } = await client.query<{ id: string; site_id: string; name: string }>(
    `SELECT id, site_id, name FROM environments WHERE id = $1 AND tenant_id = $2`,
    [envId, tenantId],
  );
  return rows[0] ?? null;
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async mint(tenantId: string, envId: string, scope: ApiKeyScope, actor: string): Promise<MintedApiKey> {
    return this.db.withTenant(tenantId, async (db) =>
      db.transaction(async (client) => {
        const env = await loadEnvironment(client, tenantId, envId);
        if (!env) throw new NotFoundException("environment not found for this tenant");

        const plaintext = generateApiKey();
        const keyHash = hashApiKey(plaintext, config.apiKeyPepper);

        const { rows } = await client.query<{ id: string; created_at: string }>(
          `INSERT INTO api_keys (env_id, tenant_id, key_hash, scope)
           VALUES ($1, $2, $3, $4)
           RETURNING id, created_at`,
          [envId, tenantId, keyHash, scope],
        );

        await this.audit.record(client, {
          tenantId,
          actor,
          action: "webdesk.apiKey.mint",
          args: { envId, scope, apiKeyId: rows[0].id },
        });

        return {
          id: rows[0].id,
          key: plaintext,
          scope,
          envId,
          tenantId,
          createdAt: rows[0].created_at,
        };
      }),
    );
  }

  /** Rotate replaces the secret material in place — same row id, same scope/env, new hash. */
  async rotate(tenantId: string, apiKeyId: string, actor: string): Promise<MintedApiKey> {
    return this.db.withTenant(tenantId, async (db) =>
      db.transaction(async (client) => {
        const { rows: existingRows } = await client.query<{ id: string; env_id: string; scope: ApiKeyScope; revoked_at: string | null }>(
          `SELECT id, env_id, scope, revoked_at FROM api_keys WHERE id = $1 AND tenant_id = $2`,
          [apiKeyId, tenantId],
        );
        const existing = existingRows[0];
        if (!existing) throw new NotFoundException("api key not found for this tenant");
        if (existing.revoked_at) throw new NotFoundException("api key is revoked — cannot rotate a revoked key");

        const plaintext = generateApiKey();
        const keyHash = hashApiKey(plaintext, config.apiKeyPepper);

        const { rows } = await client.query<{ created_at: string }>(
          `UPDATE api_keys SET key_hash = $1 WHERE id = $2 AND tenant_id = $3 RETURNING created_at`,
          [keyHash, apiKeyId, tenantId],
        );

        await this.audit.record(client, {
          tenantId,
          actor,
          action: "webdesk.apiKey.rotate",
          args: { apiKeyId },
        });

        return {
          id: apiKeyId,
          key: plaintext,
          scope: existing.scope,
          envId: existing.env_id,
          tenantId,
          createdAt: rows[0].created_at,
        };
      }),
    );
  }

  async revoke(tenantId: string, apiKeyId: string, actor: string): Promise<{ id: string; revokedAt: string }> {
    return this.db.withTenant(tenantId, async (db) =>
      db.transaction(async (client) => {
        const { rows } = await client.query<{ id: string; revoked_at: string }>(
          `UPDATE api_keys SET revoked_at = now()
             WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
             RETURNING id, revoked_at`,
          [apiKeyId, tenantId],
        );
        if (!rows[0]) {
          // Either it never existed for this tenant, or it was already revoked — both refuse the
          // same way (no information about which, and no "un-revoking" via double-call).
          const { rows: check } = await client.query(`SELECT 1 FROM api_keys WHERE id = $1 AND tenant_id = $2`, [
            apiKeyId,
            tenantId,
          ]);
          if (!check[0]) throw new NotFoundException("api key not found for this tenant");
          throw new NotFoundException("api key is already revoked");
        }

        await this.audit.record(client, {
          tenantId,
          actor,
          action: "webdesk.apiKey.revoke",
          args: { apiKeyId },
        });

        return { id: rows[0].id, revokedAt: rows[0].revoked_at };
      }),
    );
  }

  /**
   * The request-time lookup: given a tenant already resolved from the URL (never from the key
   * itself — see tenant-lookup.service.ts's header) and the plaintext key presented on the
   * request, find the matching, non-revoked row and its environment. Every call re-reads the
   * database — there is no cache layer anywhere in this path, which is what makes a revoke take
   * effect on the very next request (the ticket's "no cache window" requirement).
   */
  async resolve(tenantId: string, plaintextKey: string): Promise<ResolvedApiKey | null> {
    const keyHash = hashApiKey(plaintextKey, config.apiKeyPepper);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{
        id: string;
        env_id: string;
        scope: ApiKeyScope;
        revoked_at: string | null;
      }>(
        // tenant_id = $1 is redundant with RLS (webdesk_tenant_ctx() already scopes this to the
        // active context) but kept explicit per the app-layer-scoping doctrine (WSK-D16/§12): a
        // GUC gap must degrade to a wrong app-layer filter, not a silent cross-tenant read.
        `SELECT id, env_id, scope, revoked_at FROM api_keys WHERE tenant_id = $1 AND key_hash = $2`,
        [tenantId, keyHash],
      );
      const row = rows[0];
      if (!row || row.revoked_at) return null;

      const { rows: envRows } = await db.query<{ site_id: string; name: string }>(
        `SELECT site_id, name FROM environments WHERE id = $1 AND tenant_id = $2`,
        [row.env_id, tenantId],
      );
      const env = envRows[0];
      if (!env) return null; // orphaned key (its environment was removed) — fail closed

      return {
        apiKeyId: row.id,
        tenantId,
        envId: row.env_id,
        siteId: env.site_id,
        envName: env.name,
        scope: row.scope,
      };
    });
  }
}
