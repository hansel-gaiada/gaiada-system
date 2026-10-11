// WSK-46 (owner ruling WSK-D52) — the control-plane half of draft preview: content.previewToken (mint) and
// content.previewTokenRevoke. The public half is delivery/preview-read.ts (GET /v1/t/:tenant/preview/:token).
//
// A preview token is a BEARER CAPABILITY to ONE version of ONE content item: whoever holds the link sees
// that draft until it expires or is revoked. So minting it is a write that EXPOSES UNPUBLISHED CONTENT
// (MEDIUM, never `read`), it carries an editorial principal like the other content writes, and it runs in
// the shared command envelope (../command-envelope.ts), not in ContentCommandsService:
//   * the audit row `control.content.previewToken` is the FIRST statement of one transaction, the effect
//     (the preview_tokens row) runs on that same client, and the idempotency record is stored in it too;
//   * the plaintext token is generated here, returned ONCE, and never persisted: the row holds sha256(token),
//     and `withhold` makes the stored replay record omit the token AND the previewPath (which embeds it).
//     A replay of a mint therefore answers 409 idempotency-response-withheld (mint again under a new key);
//   * the audit row's args hash covers ids and numbers only, never the token.
//
// Refusals are the problems the content commands use (content-problem.ts): 404 site-not-found, 404
// item-not-found (unknown id, malformed id, another site's or tenant's item: one answer), 409 item-deleted,
// 409 version-not-found. Nothing here touches content_items or content_versions: minting changes no live
// content and no version.
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DbService } from "../../db/db.service";
import { computeCommandHash } from "../auth/ws4-assertion";
import type { EditorialPrincipal } from "../auth/editorial-principal";
import { CommandEnvelope } from "../command-envelope";
import type { CommandName } from "../command-types";
import { hashPreviewToken, mintPreviewToken } from "../../delivery/preview-token";
import { ControlProblem, problems } from "./content-problem";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a preview command needs from its route and the guards (the shape ContentCommandsService's context has, minus what a preview does not use). */
export interface PreviewCommandContext {
  tenant: { id: string; slug: string };
  siteId: string;
  principal: EditorialPrincipal;
  idempotencyKey: string;
}

export interface MintPreviewInput {
  /** The version to pin; undefined = the item's head version. */
  version?: number;
  /** Already normalised by the controller: 1..PREVIEW_TTL_MAX_SECONDS (0/empty became the default, over-long was capped). */
  ttlSeconds: number;
}

export interface MintedPreviewToken {
  tokenId: string;
  /** The plaintext, once. Never stored. */
  token: string;
  expiresAt: string;
  version: number;
  /** `/v1/t/<slug>/preview/<token>`: contains the token, so it is withheld from the stored replay record too. */
  previewPath: string;
}

export interface RevokedPreviewToken {
  tokenId: string;
  itemId: string;
  revokedAt: string;
  /** True when the token was already revoked: revoked_at is the ORIGINAL instant, nothing moved. */
  alreadyRevoked: boolean;
}

/** The stored replay record of a mint: everything but the secret and what embeds it. */
const withoutToken = ({ token: _token, previewPath: _previewPath, ...rest }: MintedPreviewToken): { stored: object } => ({ stored: rest });

const iso = (d: Date | string): string => new Date(d).toISOString();


@Injectable()
export class PreviewTokenCommandsService {
  constructor(
    private readonly db: DbService,
    private readonly envelope: CommandEnvelope,
  ) {}

  /**
   * Resolves the route's tenant and site. Any miss (unknown or archived tenant, a site of another tenant,
   * a malformed id) is the same 404 site-not-found: no existence oracle across tenants. (Same rule as
   * ContentCommandsService.resolveTenantSite; kept here so this command does not depend on that service.)
   */
  async resolveTenantSite(tenantSlug: string, siteId: string): Promise<{ tenant: { id: string; slug: string }; siteId: string }> {
    const tenant = await this.db.withPlatformCtx(async (client) => {
      const { rows } = await client.query<{ id: string; slug: string; status: string }>(`SELECT id, slug, status FROM tenants WHERE slug = $1`, [tenantSlug]);
      return rows[0] ?? null;
    });
    if (!tenant || tenant.status !== "active" || !UUID_RE.test(siteId)) throw problems.siteNotFound();
    const siteExists = await this.db.withTenant(tenant.id, async (db) => {
      const { rows } = await db.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenant.id]);
      return rows.length > 0;
    });
    if (!siteExists) throw problems.siteNotFound();
    return { tenant: { id: tenant.id, slug: tenant.slug }, siteId };
  }

  // ==============================================================================================
  // content.previewToken
  // ==============================================================================================
  async mint(ctx: PreviewCommandContext, itemId: string, input: MintPreviewInput, requested: { version: number | null; ttlSeconds: number | null }): Promise<MintedPreviewToken & { replayed: boolean }> {
    const command: CommandName = "content.previewToken";
    // Generated BEFORE the envelope: the audit row (its first statement) names the tokenId. The token
    // itself is never given to the audit row, the idempotency record or any log.
    const tokenId = randomUUID();
    const token = mintPreviewToken();
    const tokenHash = hashPreviewToken(token);

    return this.envelope.run<MintedPreviewToken>({
      command,
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:${command}:${ctx.idempotencyKey}`,
      // The request as the caller sent it (null = omitted), so a retry with the same key and the same
      // body is the same request, and a different body under the same key is 409 idempotency-key-reused.
      requestHash: computeCommandHash(command, { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, version: requested.version, ttlSeconds: requested.ttlSeconds }),
      actor: ctx.principal.sub,
      auditArgs: { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, tokenId, version: requested.version, ttlSeconds: input.ttlSeconds },
      ws4ApprovalId: null, // MEDIUM: no WS4 approval to claim
      effect: async (client) => {
        if (!UUID_RE.test(itemId)) throw problems.itemNotFound();
        // FOR SHARE: a concurrent content.delete (FOR UPDATE) cannot slip between this check and the insert.
        const { rows } = await client.query<{ id: string; head_version: number; deleted_at: Date | null }>(
          `SELECT id, head_version, deleted_at FROM content_items WHERE id = $1 AND site_id = $2 AND tenant_id = $3 FOR SHARE`,
          [itemId, ctx.siteId, ctx.tenant.id],
        );
        const item = rows[0];
        if (!item) throw problems.itemNotFound();
        if (item.deleted_at) throw problems.conflict("item-deleted", "Item deleted", "This item has been deleted.");

        const version = input.version ?? item.head_version;
        if (version < 1) {
          // A pre-0009 row (head 0) has no version row: nothing to pin until its first write adopts it.
          throw problems.conflict("version-not-found", "Version not found", "This item has no saved version yet, so there is nothing to preview. Save it once to create version 1.");
        }
        const found = await client.query(`SELECT 1 FROM content_versions WHERE content_item_id = $1 AND version = $2`, [itemId, version]);
        if (found.rows.length === 0) {
          throw problems.conflict("version-not-found", "Version not found", `Version ${version} does not exist for this item.`);
        }

        const { rows: ins } = await client.query<{ expires_at: Date }>(
          `INSERT INTO preview_tokens (id, tenant_id, site_id, content_item_id, version, token_hash, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::integer * interval '1 second'), $8)
           RETURNING expires_at`,
          [tokenId, ctx.tenant.id, ctx.siteId, itemId, version, tokenHash, input.ttlSeconds, ctx.principal.sub],
        );
        return {
          result: {
            tokenId,
            token,
            expiresAt: iso(ins[0].expires_at),
            version,
            previewPath: `/v1/t/${ctx.tenant.slug}/preview/${token}`,
          },
        };
      },
      withhold: withoutToken,
      withheldDetail:
        "This command's response carried a preview token, a bearer link to an unpublished draft, which is never stored. Nothing was changed. Mint a new token under a new Idempotency-Key.",
    });
  }

  // ==============================================================================================
  // content.previewTokenRevoke
  // ==============================================================================================
  async revoke(ctx: PreviewCommandContext, itemId: string, tokenId: string): Promise<RevokedPreviewToken & { replayed: boolean }> {
    const command: CommandName = "content.previewTokenRevoke";
    return this.envelope.run<RevokedPreviewToken>({
      command,
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:${command}:${ctx.idempotencyKey}`,
      requestHash: computeCommandHash(command, { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, tokenId }),
      actor: ctx.principal.sub,
      auditArgs: { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, itemId, tokenId },
      ws4ApprovalId: null,
      effect: async (client) => {
        // Not-a-uuid, unknown, another item's token and another tenant's token (invisible under RLS) are one 404.
        if (!UUID_RE.test(itemId) || !UUID_RE.test(tokenId)) throw notFound();
        const { rows } = await client.query<{ revoked_at: Date | null }>(
          `SELECT revoked_at FROM preview_tokens WHERE id = $1 AND content_item_id = $2 AND site_id = $3 AND tenant_id = $4 FOR UPDATE`,
          [tokenId, itemId, ctx.siteId, ctx.tenant.id],
        );
        if (!rows[0]) throw notFound();
        if (rows[0].revoked_at) return { result: { tokenId, itemId, revokedAt: iso(rows[0].revoked_at), alreadyRevoked: true } };
        const { rows: upd } = await client.query<{ revoked_at: Date }>(`UPDATE preview_tokens SET revoked_at = now() WHERE id = $1 RETURNING revoked_at`, [tokenId]);
        return { result: { tokenId, itemId, revokedAt: iso(upd[0].revoked_at), alreadyRevoked: false } };
      },
    });
  }
}

function notFound(): ControlProblem {
  return new ControlProblem(404, "preview-token-not-found", "Preview token not found", "No such preview token for this item.");
}
