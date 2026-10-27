// WSK-43a (owner rulings WSK-D53, WSK-D54) — the media library's control-plane writes: media.uploadToken,
// media.update, media.delete. The reads (media.list, media.usage) are content-reads.service.ts.
//
// All three are MEDIUM (webdesk:operate) and carry an editorial principal, gated exactly like the content
// writes (WSK-41) and run in the shared command envelope (../command-envelope.ts), like content.previewToken:
//   * the audit row `control.<command>` is the FIRST statement of one transaction, the effect runs on that
//     same client, and the idempotency record is stored in it too;
//   * media.uploadToken's plaintext token is generated here, returned ONCE and never persisted: the row holds
//     sha256(token), and `withhold` makes the stored replay record omit the token AND the uploadPath (which
//     embeds it). A replay of a mint answers 409 idempotency-response-withheld (mint again under a new key).
//
// media.delete is a SOFT delete (D54): the asset leaves the library and stops being served, its stored object
// stays until the GOVERNANCE retention that locks it has passed (purge_after), and the scheduler's
// `media-purge` job (scheduler/media-purge.service.ts) then deletes every stored version. It is REFUSED with
// 409 media-in-use while any non-deleted item's live projection, head version or pending swap names the asset
// (media-usage.ts), listing up to 50 of them. Deleting an already-deleted asset is a no-op that answers with
// the original instants.
//
// Refusals use the content commands' problems (content-problem.ts): 404 site-not-found (unknown tenant, site
// of another tenant), 404 media-asset-not-found (unknown id, malformed id, another site's or tenant's asset:
// one answer), 409 media-asset-deleted (update of a deleted asset), 409 media-in-use, 400 invalid-request.
import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { computeCommandHash } from "../auth/ws4-assertion";
import type { EditorialPrincipal } from "../auth/editorial-principal";
import { assertClientMayRun } from "../auth/client-editor";
import { assertContributorMayRun } from "../auth/contributor-editor";
import { CommandEnvelope } from "../command-envelope";
import type { CommandName } from "../command-types";
import { hashUploadToken, mintUploadToken, uploadPathFor, UPLOAD_TOKEN_TTL_SECONDS } from "../../media/media-upload-token";
import { allowedMimesForBucket } from "../../media/mime-allowlist";
import { toLibraryAsset, type LibraryAsset } from "../../media/library-asset";
import { MEDIA_ASSET_COLUMNS } from "../../media/media.service";
import type { MediaAssetRow } from "../../media/dto";
import { PUBLIC_BUCKETS, storageConfig, type BucketName } from "../../storage/storage.config";
import { ContentCommandsService } from "./content-commands.service";
import { ControlProblem, problems } from "./content-problem";
import { findMediaUsage, MEDIA_USAGE_LIMIT } from "./media-usage";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a media command needs from its route and the guards. */
export interface MediaCommandContext {
  tenant: { id: string; slug: string; locales: string[] };
  siteId: string;
  principal: EditorialPrincipal;
  idempotencyKey: string;
}

// ------------------------------------------------------------------------------------------------
// media.uploadToken
// ------------------------------------------------------------------------------------------------
export interface MintUploadTokenInput {
  bucket: BucketName;
  /** The effective cap (already defaulted to and capped by the media config). */
  maxBytes: number;
  /** The effective allowed mime set (already a non-empty subset of the bucket's allowlist). */
  mimes: string[];
}

export interface MintedUploadToken {
  tokenId: string;
  /** The plaintext, once. Never stored. */
  token: string;
  /** `/v1/t/<slug>/media/upload/<token>`: contains the token, so it is withheld from the stored replay record too. */
  uploadPath: string;
  expiresAt: string;
  bucket: BucketName;
  maxBytes: number;
  allowedMimes: string[];
}

const withoutToken = ({ token: _token, uploadPath: _uploadPath, ...rest }: MintedUploadToken): { stored: object } => ({ stored: rest });

// ------------------------------------------------------------------------------------------------
// media.update
// ------------------------------------------------------------------------------------------------
export const MAX_TITLE_CHARS = 200;
export const MAX_ALT_CHARS = 500;
export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;

export interface UpdateMediaInput {
  /** undefined = leave; null = clear. */
  title?: string | null;
  /** The COMPLETE alt map after the update (locale -> text); undefined = leave. */
  alt?: Record<string, string>;
  /** The complete tag list after the update; undefined = leave. */
  tags?: string[];
}

/**
 * Tags are labels people search by, so they are normalised, not stored as typed: trimmed, internal runs of
 * whitespace collapsed, lower-cased, de-duplicated (first spelling wins its position), empties dropped. A
 * list that is still too long, or a tag that is, is refused rather than silently cut.
 */
export function normaliseTags(raw: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== "string") throw problems.invalidRequest("tags must be an array of strings");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(t)) throw problems.invalidRequest("a tag may not contain control characters");
    const tag = t.trim().replace(/\s+/g, " ").toLowerCase();
    if (tag === "" || seen.has(tag)) continue;
    if (Array.from(tag).length > MAX_TAG_CHARS) throw problems.invalidRequest(`a tag may be at most ${MAX_TAG_CHARS} characters`);
    seen.add(tag);
    out.push(tag);
  }
  if (out.length > MAX_TAGS) throw problems.invalidRequest(`an asset may have at most ${MAX_TAGS} tags (after normalising, ${out.length} were given)`);
  return out;
}

// ------------------------------------------------------------------------------------------------
// media.delete
// ------------------------------------------------------------------------------------------------
export interface DeletedMedia {
  assetId: string;
  deletedAt: string;
  /** The earliest instant the stored object may be purged (deleted_at + the bucket's GOVERNANCE retention). */
  purgeAfter: string;
  /** True when the asset was already deleted: the instants are the ORIGINAL ones, nothing moved. */
  alreadyDeleted: boolean;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

@Injectable()
export class MediaCommandsService {
  constructor(
    private readonly envelope: CommandEnvelope,
    private readonly content: ContentCommandsService,
  ) {}

  /** Resolves the route's tenant and site (the write plane's own function: any miss is one 404 site-not-found). */
  async resolveTenantSite(tenantSlug: string, siteId: string): Promise<{ tenant: MediaCommandContext["tenant"]; siteId: string }> {
    const r = await this.content.resolveTenantSite(tenantSlug, siteId);
    return { tenant: { id: r.tenant.id, slug: r.tenant.slug, locales: r.tenant.locales }, siteId: r.siteId };
  }

  // ==============================================================================================
  // media.uploadToken
  // ==============================================================================================
  /**
   * The effective bucket / cap / mime set of a mint request, or a 400. The cap defaults to, and can never
   * exceed, WEBDESK_MEDIA_MAX_UPLOAD_BYTES; the mime set defaults to, and can never exceed, the bucket's
   * allowlist (the library's public buckets: media and video).
   */
  resolveMintInput(body: { bucket: unknown; maxBytes?: unknown; mime?: unknown }): { input: MintUploadTokenInput; requested: { bucket: string; maxBytes: number | null; mime: string[] | null } } {
    if (typeof body.bucket !== "string" || !(PUBLIC_BUCKETS as ReadonlySet<string>).has(body.bucket)) {
      throw problems.invalidRequest(`bucket must be one of ${[...PUBLIC_BUCKETS].join(", ")} (the library's public buckets)`);
    }
    const bucket = body.bucket as BucketName;

    const configCap = storageConfig.maxUploadSizeBytes;
    let maxBytes = configCap;
    let requestedMax: number | null = null;
    if (body.maxBytes !== undefined && body.maxBytes !== null) {
      if (typeof body.maxBytes !== "number" || !Number.isSafeInteger(body.maxBytes) || body.maxBytes < 1) {
        throw problems.invalidRequest(`maxBytes must be a positive integer number of bytes (default and maximum ${configCap})`);
      }
      requestedMax = body.maxBytes;
      maxBytes = Math.min(body.maxBytes, configCap);
    }

    const bucketMimes = allowedMimesForBucket(bucket);
    let mimes = [...bucketMimes];
    let requestedMime: string[] | null = null;
    if (body.mime !== undefined && body.mime !== null) {
      const list = typeof body.mime === "string" ? [body.mime] : body.mime;
      if (!Array.isArray(list) || list.length === 0 || list.length > bucketMimes.length || list.some((m) => typeof m !== "string")) {
        throw problems.invalidRequest("mime must be a media type or a non-empty array of media types");
      }
      const wanted = [...new Set((list as string[]).map((m) => m.trim().toLowerCase()))];
      const refused = wanted.filter((m) => !bucketMimes.includes(m));
      if (refused.length > 0) {
        throw problems.invalidRequest(`mime ${refused.join(", ")} is not allowed in bucket '${bucket}' (allowed: ${bucketMimes.join(", ")})`);
      }
      requestedMime = wanted;
      mimes = wanted;
    }
    return { input: { bucket, maxBytes, mimes }, requested: { bucket, maxBytes: requestedMax, mime: requestedMime } };
  }

  async mintUploadToken(
    ctx: MediaCommandContext,
    input: MintUploadTokenInput,
    requested: { bucket: string; maxBytes: number | null; mime: string[] | null },
  ): Promise<MintedUploadToken & { replayed: boolean }> {
    const command: CommandName = "media.uploadToken";
    // WSK-49b: a client editor may not run every command (CLIENT_EDITOR_COMMANDS); the guard checks too.
    assertClientMayRun(ctx.principal, command);
    assertContributorMayRun(ctx.principal, command);
    // Generated BEFORE the envelope: the audit row (its first statement) names the tokenId. The token
    // itself is never given to the audit row, the idempotency record or any log.
    const tokenId = randomUUID();
    const token = mintUploadToken();
    const tokenHash = hashUploadToken(token);

    return this.envelope.run<MintedUploadToken>({
      command,
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:${command}:${ctx.idempotencyKey}`,
      // The request as the caller sent it (null = omitted): the same body under the same key is the same
      // request, a different body under the same key is 409 idempotency-key-reused.
      requestHash: computeCommandHash(command, { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, bucket: requested.bucket, maxBytes: requested.maxBytes, mime: requested.mime }),
      actor: ctx.principal.sub,
      auditArgs: { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, tokenId, bucket: input.bucket, maxBytes: input.maxBytes, allowedMimes: input.mimes.join(",") },
      ws4ApprovalId: null, // MEDIUM: no WS4 approval to claim
      effect: async (client) => {
        const { rows } = await client.query<{ expires_at: Date }>(
          `INSERT INTO media_upload_tokens (id, tenant_id, site_id, token_hash, bucket, max_bytes, allowed_mimes, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8::integer * interval '1 second'), $9)
           RETURNING expires_at`,
          [tokenId, ctx.tenant.id, ctx.siteId, tokenHash, input.bucket, input.maxBytes, input.mimes, UPLOAD_TOKEN_TTL_SECONDS, ctx.principal.sub],
        );
        return {
          result: {
            tokenId,
            token,
            uploadPath: uploadPathFor(ctx.tenant.slug, token),
            expiresAt: iso(rows[0].expires_at),
            bucket: input.bucket,
            maxBytes: input.maxBytes,
            allowedMimes: input.mimes,
          },
        };
      },
      withhold: withoutToken,
      withheldDetail:
        "This command's response carried an upload token, a bearer credential to upload one file, which is never stored. Nothing was changed. Mint a new token under a new Idempotency-Key.",
    });
  }

  // ==============================================================================================
  // media.update
  // ==============================================================================================
  async update(ctx: MediaCommandContext, assetId: string, input: UpdateMediaInput): Promise<{ asset: LibraryAsset } & { replayed: boolean }> {
    const command: CommandName = "media.update";
    // WSK-49b: a client editor may not run every command (CLIENT_EDITOR_COMMANDS); the guard checks too.
    assertClientMayRun(ctx.principal, command);
    assertContributorMayRun(ctx.principal, command);
    // Shape against the tenant's own locales: before the envelope, so a refusal claims no idempotency key.
    if (input.alt !== undefined) {
      const unknown = Object.keys(input.alt).filter((l) => !ctx.tenant.locales.includes(l));
      if (unknown.length > 0) {
        throw problems.invalidRequest(`alt has locale(s) the tenant does not declare: ${unknown.join(", ")} (declared: ${ctx.tenant.locales.join(", ")})`);
      }
    }
    return this.envelope.run<{ asset: LibraryAsset }>({
      command,
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:${command}:${ctx.idempotencyKey}`,
      requestHash: computeCommandHash(command, { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, assetId, ...input }),
      actor: ctx.principal.sub,
      auditArgs: { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, assetId, fields: Object.keys(input).sort().join(",") },
      ws4ApprovalId: null,
      effect: async (client) => {
        if (!UUID_RE.test(assetId)) throw assetNotFound();
        const { rows } = await client.query<{ deleted_at: Date | null }>(
          `SELECT deleted_at FROM media_assets WHERE id = $1 AND site_id = $2 AND tenant_id = $3 FOR UPDATE`,
          [assetId, ctx.siteId, ctx.tenant.id],
        );
        if (!rows[0]) throw assetNotFound();
        if (rows[0].deleted_at) throw problems.conflict("media-asset-deleted", "Media asset deleted", "This asset has been deleted; it can no longer be edited.");

        const sets: string[] = [];
        const params: unknown[] = [assetId];
        const set = (column: string, value: unknown, cast = "") => {
          params.push(value);
          sets.push(`${column} = $${params.length}${cast}`);
        };
        if (input.title !== undefined) set("title", input.title);
        if (input.alt !== undefined) set("alt", JSON.stringify(input.alt), "::jsonb");
        if (input.tags !== undefined) set("tags", input.tags, "::text[]");
        const { rows: updated } = await client.query<MediaAssetRow>(
          `UPDATE media_assets SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${MEDIA_ASSET_COLUMNS}`,
          params,
        );
        return { result: { asset: toLibraryAsset(updated[0], ctx.tenant.slug) } };
      },
    });
  }

  // ==============================================================================================
  // media.delete
  // ==============================================================================================
  async delete(ctx: MediaCommandContext, assetId: string): Promise<DeletedMedia & { replayed: boolean }> {
    const command: CommandName = "media.delete";
    // WSK-49b: a client editor may not run every command (CLIENT_EDITOR_COMMANDS); the guard checks too.
    assertClientMayRun(ctx.principal, command);
    assertContributorMayRun(ctx.principal, command);
    // Read before the envelope's transaction so a misconfigured retention is a loud 500 that claims nothing.
    const retentionDays = storageConfig.objectLockRetentionDays;
    return this.envelope.run<DeletedMedia>({
      command,
      scope: { kind: "tenant", tenantId: ctx.tenant.id },
      scopeKey: `${ctx.tenant.slug}:${command}:${ctx.idempotencyKey}`,
      requestHash: computeCommandHash(command, { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, assetId }),
      actor: ctx.principal.sub,
      auditArgs: { tenantSlug: ctx.tenant.slug, siteId: ctx.siteId, assetId },
      ws4ApprovalId: null,
      effect: async (client) => {
        if (!UUID_RE.test(assetId)) throw assetNotFound();
        const { rows } = await client.query<{ deleted_at: Date | null; purge_after: Date | null }>(
          `SELECT deleted_at, purge_after FROM media_assets WHERE id = $1 AND site_id = $2 AND tenant_id = $3 FOR UPDATE`,
          [assetId, ctx.siteId, ctx.tenant.id],
        );
        const asset = rows[0];
        if (!asset) throw assetNotFound();
        // Idempotent: an already-deleted asset is not re-judged (it was unused when it went) and not moved.
        if (asset.deleted_at && asset.purge_after) {
          return { result: { assetId, deletedAt: iso(asset.deleted_at), purgeAfter: iso(asset.purge_after), alreadyDeleted: true } };
        }

        const usage = await findMediaUsage(client, { tenantId: ctx.tenant.id, siteId: ctx.siteId, assetId, limit: MEDIA_USAGE_LIMIT });
        if (usage.total > 0) {
          throw problems.conflict(
            "media-in-use",
            "Media asset in use",
            `This asset is still used by ${usage.total} content item(s); remove it from them first. Nothing was deleted.`,
            { usage: usage.items, total: usage.total },
          );
        }

        const { rows: done } = await client.query<{ deleted_at: Date; purge_after: Date }>(
          `UPDATE media_assets
              SET deleted_at = now(), purge_after = now() + ($2::integer * interval '1 day'), updated_at = now()
            WHERE id = $1
        RETURNING deleted_at, purge_after`,
          [assetId, retentionDays],
        );
        return { result: { assetId, deletedAt: iso(done[0].deleted_at), purgeAfter: iso(done[0].purge_after), alreadyDeleted: false } };
      },
    });
  }
}

function assetNotFound(): ControlProblem {
  return new ControlProblem(404, "media-asset-not-found", "Media asset not found", "No such media asset on this site.");
}
