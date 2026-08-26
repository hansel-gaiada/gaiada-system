// WSK-05 — a MINIMAL, demonstrative content read/write path, existing only to prove the
// scoped-auth middleware + per-tenant quota actually gate a "content route" end to end, per the
// ticket's AC ("scoped-read middleware on all content routes"). The real `/v1` envelope
// (vocabulary, blocks, locale-aware serialization, RFC 9457 errors, pagination) is WSK-06's frozen
// design (§05) — this file does not attempt any of that, on purpose, so as not to pre-empt it.
// WSK-06 should mount its real handlers behind the SAME three guards
// (ApiKeyAuthGuard, ScopeGuard, TenantQuotaGuard) rather than reinvent them.
//
// Environment semantics (underspecified in §04 — content_items carries no `environment` column;
// api_keys.env_id points at ONE specific environment of ONE specific site): the resolution used
// here is that "environment" gates PUBLICATION VISIBILITY, not a separate copy of the data — a
// `staging` key sees draft/scheduled/unpublished items too, a `production` key sees only
// `publish_state = 'published'`. Content itself is always scoped to the key's own site_id
// (env_id -> environments.site_id), which is the part of "grants exactly its ... env ... tenant"
// that actually has a row-level enforcement point today.
import { Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../db/db.service";
import type { ResolvedApiKey } from "../api-keys/api-keys.service";

export type ContentItemRow = {
  id: string;
  slug: string;
  locale: string;
  publish_state: string;
  blocks: unknown;
  updated_at: string;
};

@Injectable()
export class ContentService {
  constructor(private readonly db: DbService) {}

  async list(auth: ResolvedApiKey): Promise<ContentItemRow[]> {
    return this.db.withTenant(auth.tenantId, async (db) => {
      const productionOnly = auth.envName === "production";
      const { rows } = await db.query<ContentItemRow>(
        `SELECT id, slug, locale, publish_state, blocks, updated_at
           FROM content_items
          WHERE site_id = $1
            AND ($2::boolean = false OR publish_state = 'published')
          ORDER BY updated_at DESC`,
        [auth.siteId, productionOnly],
      );
      return rows;
    });
  }

  async create(
    auth: ResolvedApiKey,
    input: { collectionKey: string; locale: string; slug: string; blocks?: unknown[] },
  ): Promise<ContentItemRow> {
    return this.db.withTenant(auth.tenantId, async (db) =>
      db.transaction(async (client) => {
        const { rows: collectionRows } = await client.query<{ id: string }>(
          `SELECT id FROM collections WHERE site_id = $1 AND key = $2`,
          [auth.siteId, input.collectionKey],
        );
        const collection = collectionRows[0];
        if (!collection) throw new NotFoundException("collection not found for this site");

        const { rows } = await client.query<ContentItemRow>(
          `INSERT INTO content_items (tenant_id, site_id, collection_id, locale, slug, blocks)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, slug, locale, publish_state, blocks, updated_at`,
          [auth.tenantId, auth.siteId, collection.id, input.locale, input.slug, JSON.stringify(input.blocks ?? [])],
        );
        return rows[0];
      }),
    );
  }
}
