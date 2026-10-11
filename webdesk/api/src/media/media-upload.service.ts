// WSK-43a — redeeming a media upload token: the server half of `POST /v1/t/:tenantSlug/media/upload/:token`.
//
// THE SURFACE. This route is public and its caller is untrusted: the token is the only credential and the
// body is whatever the caller sends. The rules, in the order they are enforced:
//
//   1. THE TOKEN, FIRST AND ALONE. Nothing about the request (its body, its headers) is looked at before the
//      token is proven. The token is hashed and claimed by ONE statement,
//        UPDATE media_upload_tokens SET used_at = now()
//         WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()
//      under the route's tenant context (RLS). An unknown, malformed, expired, spent or other-tenant's token
//      is the same zero rows, hence ONE identical 404 (the same body as an unknown tenant slug): the route
//      cannot be used to learn why a token failed.
//   2. THE CLAIM IS THE LOCK. The UPDATE runs in the SAME transaction that later creates the asset row, and
//      that transaction stays open while the body is read, scanned and stored. The claim selects its row
//      `FOR UPDATE SKIP LOCKED`, so a second request with the token while the first is in flight finds
//      nothing and gets the same 404 AT ONCE: it neither waits nor holds a pooled connection. Once the first
//      commits the token is spent (404); if it rolls back, the token is free again. So a token uploads
//      exactly once even under concurrency, a loser has not read or stored a byte, and a refused upload (too
//      big, wrong type, infected, storage down) rolls the claim back and leaves the token usable until it
//      expires.
//   2b. SLOTS (UploadSlots, below). An in-flight upload holds one pooled connection for the whole transfer, and
//      the pool is small and shared with the rest of the api, so a slow sender must not be able to drain it.
//      Before the token is even looked at, a process admits at most WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT uploads
//      (default 4) and WEBDESK_MEDIA_UPLOAD_MAX_PER_TENANT per tenant (default 2); the rest get 503 with
//      Retry-After. The check comes first on purpose: it says nothing about any token, so it is no oracle.
//   3. THE BODY IS BOUNDED WHILE IT STREAMS. The cap is min(the token's max_bytes, WEBDESK_MEDIA_MAX_UPLOAD_BYTES).
//      A declared Content-Length over it is refused (413) before a byte is read; a body without one is
//      counted as it arrives and refused the moment it crosses the cap, so nothing larger than the cap is ever
//      held in memory. A read deadline (WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS, 60 s) ends a stalled sender.
//   4. THE TOKEN'S TYPE SET, THEN THE EXISTING PIPELINE. The declared content type must be in the token's
//      allowed set (415 otherwise, before the body is read). The bytes then go through MediaService.screen /
//      storeObject / recordAsset, the same code the API-key route runs: bucket allowlist, magic-byte sniff,
//      quota, ClamAV (fail closed), store, row, audit. This file adds no second pipeline.
//   5. CORS (preview-token.ts allowedPreviewOrigin, the same rule as the draft-preview route): the response may
//      be read by script only from `https://<domain>` of an environment of the token's site. The decision
//      needs the token's site, so it exists only once the token is proven; errors before that carry no CORS.
//
// The asset's attribution (`created_by`) is the token's: the editorial principal that minted it, recorded as
// the actor of the `webdesk.media.upload` audit row. (media_assets has no created_by column; migration 0014
// does not add one.)
import { BadRequestException, Injectable, Logger, NotFoundException, PayloadTooLargeException, RequestTimeoutException, UnsupportedMediaTypeException } from "@nestjs/common";
import type { Readable } from "node:stream";
import { DbService } from "../db/db.service";
import { allowedPreviewOrigin } from "../delivery/preview-token";
import { storageConfig, type BucketName } from "../storage/storage.config";
import { readImageDimensions } from "./image-dimensions";
import { toLibraryAsset, type LibraryAsset } from "./library-asset";
import { InfectedUploadError, MediaService, type StoredObject } from "./media.service";
import { hashUploadToken, UPLOAD_TOKEN_RE } from "./media-upload-token";

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
export class MediaUploadService {
  private readonly logger = new Logger(MediaUploadService.name);
  readonly slots = new UploadSlots();

  constructor(
    private readonly db: DbService,
    private readonly media: MediaService,
  ) {}

  /**
   * The CORS preflight of the upload route: only a token that could still be redeemed answers (everything
   * else is `null`, the route's one 404). Returns the Origin to echo, or null (no CORS headers).
   * Read-only: a preflight never spends a token.
   */
  async preflight(tenantId: string, token: string, origin: string | null): Promise<{ allowOrigin: string | null } | null> {
    if (!UPLOAD_TOKEN_RE.test(token)) return null;
    const hash = hashUploadToken(token);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ site_id: string }>(
        `SELECT site_id FROM media_upload_tokens WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()`,
        [hash, tenantId],
      );
      if (!rows[0]) return null;
      const domains = await this.siteDomains(db, rows[0].site_id, tenantId);
      return { allowOrigin: allowedPreviewOrigin(origin, domains) };
    });
  }

  private async siteDomains(db: Pick<DbService, "query">, siteId: string, tenantId: string): Promise<string[]> {
    const { rows } = await db.query<{ domain: string }>(
      `SELECT domain FROM environments WHERE site_id = $1 AND tenant_id = $2 AND domain IS NOT NULL AND domain <> ''`,
      [siteId, tenantId],
    );
    return rows.map((r) => r.domain);
  }

  /**
   * Redeems the token with this request's body. `onAuthorized` is called once the token is proven, with the
   * Origin to echo for CORS (or null): the controller sets the response header there, so every later answer,
   * the errors included, is readable by the site's own script.
   */
  async redeem(p: {
    tenantId: string;
    tenantSlug: string;
    token: string;
    origin: string | null;
    contentType: string | undefined;
    contentLength: number | null;
    filename: string | null;
    body: Readable;
    onAuthorized: (allowOrigin: string | null) => void;
  }): Promise<LibraryAsset> {
    if (!UPLOAD_TOKEN_RE.test(p.token)) throw new NotFoundException();
    const hash = hashUploadToken(p.token);

    // Facts the failure paths below need after the transaction has rolled back.
    const left: { claimed?: ClaimedToken; stored?: StoredObject; infected?: InfectedUploadError } = {};
    try {
      return await this.db.withTenant(p.tenantId, (db) =>
        db.transaction(async (client) => {
          // 1 + 2. Prove and claim the token in one statement, in the transaction that will create the asset.
          const { rows } = await client.query<ClaimedToken>(
            `UPDATE media_upload_tokens SET used_at = now()
              WHERE id = (SELECT id FROM media_upload_tokens
                           WHERE token_hash = $1 AND tenant_id = $2 AND used_at IS NULL AND expires_at > now()
                           FOR UPDATE SKIP LOCKED)
          RETURNING id, site_id, bucket, max_bytes, allowed_mimes, created_by`,
            [hash, p.tenantId],
          );
          if (!rows[0]) throw new NotFoundException();
          const token = rows[0];
          left.claimed = token;

          // 5. CORS, now that the token's site is known.
          const domains = await this.siteDomains(client, token.site_id, p.tenantId);
          p.onAuthorized(allowedPreviewOrigin(p.origin, domains));

          // 4. The token's type set, before a byte is read.
          const contentType = baseContentType(p.contentType);
          if (!contentType || !token.allowed_mimes.includes(contentType)) {
            throw new UnsupportedMediaTypeException(`content-type '${contentType ?? "(none)"}' is not allowed for this upload token`);
          }

          // 3. The size cap, declared first, then counted as the body streams.
          const cap = Math.min(Number(token.max_bytes), storageConfig.maxUploadSizeBytes);
          if (p.contentLength !== null && p.contentLength > cap) {
            throw new PayloadTooLargeException(`upload exceeds the ${cap}-byte limit of this token`);
          }
          const buffer = await readBounded(p.body, cap, uploadTimeoutMs());

          // 4. The existing pipeline: allowlist, sniff, quota, scan.
          const input = { filename: p.filename ?? "file", contentType, buffer };
          let screened;
          try {
            screened = await this.media.screen(p.tenantId, token.bucket, input, { maxBytes: cap, allowedMimes: token.allowed_mimes }, client);
          } catch (err) {
            if (err instanceof InfectedUploadError) left.infected = err;
            throw err;
          }

          // Store, then record: the row (and the token's spent state) commit together or not at all.
          const stored = await this.media.storeObject(p.tenantId, token.site_id, token.bucket, input);
          left.stored = stored;
          const dims = readImageDimensions(buffer, screened.sniffed);
          const row = await this.media.recordAsset(client, {
            tenantId: p.tenantId,
            siteId: token.site_id,
            bucket: token.bucket,
            input,
            stored,
            actor: token.created_by,
            facts: { originalFilename: p.filename, width: dims?.width ?? null, height: dims?.height ?? null },
            auditExtra: { via: "upload-token", tokenId: token.id },
          });
          return toLibraryAsset(row, p.tenantSlug);
        }),
      );
    } catch (err) {
      // The transaction has rolled back (the token is unspent again). What it left behind:
      if (left.stored && left.claimed) await this.media.discardObject(left.claimed.bucket, left.stored.objectKey);
      if (left.infected && left.claimed) {
        const { bucket, created_by } = left.claimed;
        await this.media
          .refuseInfected(p.tenantId, created_by, bucket, p.filename ?? "file", left.infected.signature)
          .catch((e) => this.logger.warn(`could not audit the refused upload: ${String(e)}`));
        throw left.infected.toForbidden();
      }
      throw err;
    }
  }
}
