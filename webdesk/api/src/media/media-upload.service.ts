// WSK-43a — redeeming a media upload token: the server half of `POST /v1/t/:tenantSlug/media/upload/:token`.
//
// THE SURFACE. This route is public and its caller is untrusted: the token is the only credential and the
// body is whatever the caller sends. The rules, in the order they are enforced:
//
//   1. THE TOKEN, FIRST AND ALONE. Nothing about the request (its body, its headers) is looked at before the
//      token is proven. The token is hashed and looked up under the route's tenant context (RLS). An unknown,
//      malformed, expired, spent or other-tenant's token is the same zero rows, hence ONE identical 404 (the
//      same body as an unknown tenant slug): the route cannot be used to learn why a token failed.
//   2. NO POOLED CONNECTION IS HELD WHILE BYTES MOVE. The api's pool is small (10) and shared with every read, so
//      a slow or stalled sender must never pin a connection. The route therefore uses the database in three
//      SHORT, separate steps and none of them spans the transfer:
//        a. look the token up (a query, no lock) and check what the headers alone can refuse: the declared
//           content type against the token's set (415) and a declared Content-Length against the cap (413).
//           These refusals leave the token unspent;
//        b. CLAIM the token in its own transaction, committed before the body is read:
//             UPDATE media_upload_tokens SET used_at = now()
//              WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()
//           Zero rows is the same 404. This one statement is what makes the token single-use under
//           concurrency: of two racing requests exactly one updates the row (the other waits only for that
//           statement, milliseconds, then finds it spent). A loser has read and stored nothing;
//        c. only after the body has been read, screened and stored, insert the asset row (and its audit row) in a
//           second short transaction.
//      THE TOKEN IS CONSUMED FROM STEP b ON, whatever happens next (fail closed): if the body, the scan, the store
//      or the row insert fails, the editor mints a new token. What is left behind: before the scan nothing was
//      stored, and the scan runs BEFORE the store (today and now), so a refused or infected file never reaches
//      storage. If the store succeeded and the row insert then failed, the object is deleted at once and a
//      soft-deleted row is written for it (see MediaService.recordTombstone): on a locked bucket the delete only
//      adds a marker, and the row is what lets the `media-purge` job free the locked version once its retention
//      lapses; if even that row cannot be written the failure is logged with the object key.
//   2b. SLOTS (UploadSlots, below). The slots no longer protect the pool; they BOUND CONCURRENT UPLOADS, that is
//      the memory (each holds a body of up to the cap), the ClamAV sockets and the storage writes one process
//      takes on at once, defence in depth against many slow senders each with a valid token. Before the token
//      is even looked at, a process admits at most WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT uploads (default 4) and
//      WEBDESK_MEDIA_UPLOAD_MAX_PER_TENANT per tenant (default 2); the rest get 503 with Retry-After. The check
//      comes first on purpose: it says nothing about any token, so it is no oracle.
//   3. THE BODY IS BOUNDED WHILE IT STREAMS. The cap is min(the token's max_bytes, WEBDESK_MEDIA_MAX_UPLOAD_BYTES).
//      A declared Content-Length over it is refused (413) before a byte is read; a body without one is
//      counted as it arrives and refused the moment it crosses the cap, so nothing larger than the cap is ever
//      held in memory. A read deadline (WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS, 60 s) ends a stalled sender.
//   4. THE TOKEN'S TYPE SET, THEN THE EXISTING PIPELINE. The declared content type must be in the token's
//      allowed set (415 otherwise, before the body is read). The bytes then go through MediaService.screen /
//      storeObject / recordAsset, the same code the API-key route runs: bucket allowlist, magic-byte sniff,
//      quota, ClamAV (fail closed), store, row, audit. This file adds no second pipeline.
//   5. CORS is NOT decided here: it is the controller's, from configuration (upload-cors.ts,
//      WEBDESK_UPLOAD_CORS_ORIGINS): the upload comes from the ERP's origin, not the tenant site's. It depends on
//      the request's Origin alone, never on the token, so it is no oracle.
//
// The asset's attribution is the token's `created_by`: the editorial principal that minted it, stored on
// media_assets.created_by (migration 0014) and as the actor of the `webdesk.media.upload` audit row.
import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleInit, PayloadTooLargeException, RequestTimeoutException, UnsupportedMediaTypeException } from "@nestjs/common";
import type { Readable } from "node:stream";
import { DbService } from "../db/db.service";
import { storageConfig, type BucketName } from "../storage/storage.config";
import { readImageDimensions } from "./image-dimensions";
import { toLibraryAsset, type LibraryAsset } from "./library-asset";
import { InfectedUploadError, MediaService } from "./media.service";
import { hashUploadToken, UPLOAD_TOKEN_RE } from "./media-upload-token";
import { uploadCorsOrigins } from "./upload-cors";

/** The longest the body may take to arrive, from the moment the token is proven. */
function uploadTimeoutMs(): number {
  const raw = (process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS ?? "").trim();
  if (raw === "") return 60_000;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1000 || n > 600_000) {
    throw new Error(`[webdesk:api] WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS=${JSON.stringify(raw)} must be a whole number of milliseconds from 1000 to 600000 (unset for 60000).`);
  }
  return n;
}

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`[webdesk:api] ${name}=${JSON.stringify(raw)} must be a whole number from ${min} to ${max} (unset for ${fallback}).`);
  }
  return n;
}

/**
 * How many token uploads one api process runs at once, and how many for one tenant (see the header, 2b). A
 * slot is taken before the token is looked at and given back when the request ends, however it ends.
 */
export class UploadSlots {
  private active = 0;
  private readonly perTenant = new Map<string, number>();

  /** A release function, or null when this process (or this tenant) is at its limit. */
  tryAcquire(tenantId: string): (() => void) | null {
    const max = boundedInt("WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT", 4, 1, 8);
    const maxTenant = Math.min(max, boundedInt("WEBDESK_MEDIA_UPLOAD_MAX_PER_TENANT", 2, 1, 8));
    const mine = this.perTenant.get(tenantId) ?? 0;
    if (this.active >= max || mine >= maxTenant) return null;
    this.active++;
    this.perTenant.set(tenantId, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const left = (this.perTenant.get(tenantId) ?? 1) - 1;
      if (left <= 0) this.perTenant.delete(tenantId);
      else this.perTenant.set(tenantId, left);
    };
  }
}

interface ClaimedToken {
  id: string;
  site_id: string;
  bucket: BucketName;
  max_bytes: string; // bigint
  allowed_mimes: string[];
  created_by: string;
}

/** The base type of a Content-Type header, lower-cased: `image/png; charset=x` -> `image/png`. */
export function baseContentType(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const base = header.split(";")[0].trim().toLowerCase();
  return base === "" ? null : base;
}

/**
 * The filename an editor uploaded under, made safe to store and show: the last path segment, control
 * characters removed, trimmed, at most 255 characters. null when nothing is left. It is a label only: the
 * stored object's key is built separately (key-prefix.ts) and never contains it unsanitised.
 */
export function cleanOriginalFilename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const base = (raw.split(/[/\\]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (base === "" || base === "." || base === "..") return null;
  return Array.from(base).slice(0, 255).join("");
}

/**
 * Reads a request body into memory, but never more than `maxBytes` and never for longer than `timeoutMs`.
 * The moment the count passes the cap it stops reading and refuses (413); nothing past the cap is kept.
 */
export function readBounded(stream: Readable, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (err: Error | null, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
      if (err) {
        stream.pause(); // stop pulling; the caller answers with `Connection: close`
        reject(err);
      } else resolve(buf as Buffer);
    };
    const onData = (chunk: Buffer | string) => {
      const c = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += c.length;
      if (total > maxBytes) return finish(new PayloadTooLargeException(`upload exceeds the ${maxBytes}-byte limit of this token`));
      chunks.push(c);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, total));
    const onError = (e: Error) => finish(e);
    // A client that goes away mid-body: 'close' without 'end'.
    const onClose = () => finish(new BadRequestException("the upload was interrupted"));
    const timer = setTimeout(() => finish(new RequestTimeoutException("the upload did not arrive in time")), timeoutMs);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
    stream.on("close", onClose);
  });
}

@Injectable()
export class MediaUploadService implements OnModuleInit {
  private readonly logger = new Logger(MediaUploadService.name);
  readonly slots = new UploadSlots();

  /** Refuses to boot on a malformed WEBDESK_UPLOAD_CORS_ORIGINS (upload-cors.ts), naming the variable. */
  onModuleInit(): void {
    uploadCorsOrigins();
  }

  constructor(
    private readonly db: DbService,
    private readonly media: MediaService,
  ) {}

  /**
   * Is this token one that could still be redeemed? (The preflight answers only for such a token; everything
   * else is the route's one 404.) Read-only: a preflight never spends a token.
   */
  async redeemable(tenantId: string, token: string): Promise<boolean> {
    if (!UPLOAD_TOKEN_RE.test(token)) return false;
    const hash = hashUploadToken(token);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query(
        `SELECT 1 FROM media_upload_tokens WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()`,
        [hash, tenantId],
      );
      return rows.length > 0;
    });
  }

  /**
   * Redeems the token with this request's body (see the header for the three short database steps).
   */
  async redeem(p: {
    tenantId: string;
    tenantSlug: string;
    token: string;
    contentType: string | undefined;
    contentLength: number | null;
    filename: string | null;
    body: Readable;
  }): Promise<LibraryAsset> {
    if (!UPLOAD_TOKEN_RE.test(p.token)) throw new NotFoundException();
    const hash = hashUploadToken(p.token);

    // a. Look the token up (no lock, no transaction held) and refuse what the headers alone can refuse.
    const found = await this.db.withTenant(p.tenantId, async (db) => {
      const { rows } = await db.query<ClaimedToken>(
        `SELECT id, site_id, bucket, max_bytes, allowed_mimes, created_by FROM media_upload_tokens
          WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()`,
        [hash, p.tenantId],
      );
      return rows[0] ?? null;
    });
    if (!found) throw new NotFoundException();

    const contentType = baseContentType(p.contentType);
    if (!contentType || !found.allowed_mimes.includes(contentType)) {
      throw new UnsupportedMediaTypeException(`content-type '${contentType ?? "(none)"}' is not allowed for this upload token`);
    }
    const cap = Math.min(Number(found.max_bytes), storageConfig.maxUploadSizeBytes);
    if (p.contentLength !== null && p.contentLength > cap) {
      throw new PayloadTooLargeException(`upload exceeds the ${cap}-byte limit of this token`);
    }

    // b. Claim it: its own short transaction, committed before the body is read. From here the token is spent.
    const token = await this.db.withTenant(p.tenantId, (db) =>
      db.transaction(async (client) => {
        const { rows } = await client.query<ClaimedToken>(
          `UPDATE media_upload_tokens SET used_at = now()
            WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING id, site_id, bucket, max_bytes, allowed_mimes, created_by`,
          [hash, p.tenantId],
        );
        return rows[0] ?? null;
      }),
    );
    if (!token) throw new NotFoundException(); // lost the race: another request spent it between a and b

    // The transfer: no database connection is held from here until the row insert.
    const buffer = await readBounded(p.body, cap, uploadTimeoutMs());
    const input = { filename: p.filename ?? "file", contentType, buffer };
    let screened;
    try {
      screened = await this.media.screen(p.tenantId, token.bucket, input, { maxBytes: cap, allowedMimes: token.allowed_mimes });
    } catch (err) {
      if (err instanceof InfectedUploadError) {
        await this.media
          .refuseInfected(p.tenantId, token.created_by, token.bucket, input.filename, err.signature)
          .catch((e) => this.logger.warn(`could not audit the refused upload: ${String(e)}`));
        throw err.toForbidden();
      }
      throw err;
    }
    const stored = await this.media.storeObject(p.tenantId, token.site_id, token.bucket, input);

    // c. The asset row: a second short transaction.
    const dims = readImageDimensions(buffer, screened.sniffed);
    try {
      const row = await this.db.withTenant(p.tenantId, (db) =>
        db.transaction((client) =>
          this.media.recordAsset(client, {
            tenantId: p.tenantId,
            siteId: token.site_id,
            bucket: token.bucket,
            input,
            stored,
            actor: token.created_by,
            facts: { originalFilename: p.filename, width: dims?.width ?? null, height: dims?.height ?? null },
            auditExtra: { via: "upload-token", tokenId: token.id },
          }),
        ),
      );
      return toLibraryAsset(row, p.tenantSlug);
    } catch (err) {
      // The object is stored but has no row: delete it, and leave a soft-deleted row so a locked version is freed later.
      await this.media.discardObject(token.bucket, stored.objectKey);
      await this.media
        .recordTombstone({ tenantId: p.tenantId, siteId: token.site_id, bucket: token.bucket, input, stored, actor: token.created_by })
        .catch((e) => this.logger.error(`orphan object ${token.bucket}/${stored.objectKey}: its row insert failed and so did its tombstone: ${String(e)}`));
      throw err;
    }
  }
}
