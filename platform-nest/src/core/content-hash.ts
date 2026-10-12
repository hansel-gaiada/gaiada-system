// PV5-06 - the SHA-256 of what a contract says, computed on the SERVER from bytes it holds.
//
// A contract's content is "fixed" when it is sent (PV-D8, plan decision 11): the hash of the attached file's
// stored bytes, or, when no file is attached, of the exact UTF-8 `body_md`. The hash is stored on the contract and
// echoed by every signature. Nothing here ever reads a client-supplied hash: a client's value is only ever an
// "what I saw" echo, compared against the stored one.
//
// `files.sha256` (PV5-01a) is written on every upload where the bytes are in hand, with the same function, so a
// stored file can later be checked against what was recorded when it arrived.
import { createHash } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { storage } from "./storage";

/** Lower-case hex SHA-256 (64 chars, the shape of every `*_sha256` CHECK in PV5-01a). */
export function sha256Hex(data: Uint8Array | string): string {
  // A string is hashed as its UTF-8 bytes (Node's default encoding for `update(string)`).
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The hash that fixes a contract's content, from the stored bytes.
 *
 * `file_id` set: the stored file's bytes. A file with no stored bytes (a reference-only attach: a filename and a
 * link, no blob) cannot be fixed, because there is nothing for a hash to cover, so the send is refused. `file_id`
 * unset: the UTF-8 bytes of `body_md`, exactly as stored (no trim, no newline normalisation).
 *
 * If `files.sha256` was recorded at upload and the stored bytes no longer match it, the file changed on disk after
 * it arrived; that is a 409, never a silent re-hash.
 */
export async function contractContentSha256(
  c: PoolClient, tenantId: string, k: { file_id: string | null; body_md: string | null },
): Promise<string> {
  if (!k.file_id) {
    if (k.body_md === null || k.body_md === "") throw new BadRequestException("attach a document or write the terms before sending");
    return sha256Hex(k.body_md);
  }
  const f = await c.query<{ storage_key: string | null; sha256: string | null }>(
    `SELECT storage_key, sha256 FROM files WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [k.file_id, tenantId],
  );
  const row = f.rows[0];
  if (!row) throw new BadRequestException("the attached document no longer exists; attach it again before sending");
  if (!row.storage_key) {
    throw new BadRequestException("the attached document has no stored content (it is a link only); upload the file before sending");
  }
  let bytes: Buffer;
  try {
    bytes = await storage().get(row.storage_key);
  } catch {
    throw new ConflictException("the attached document's stored content could not be read; upload it again before sending");
  }
  const hash = sha256Hex(bytes);
  if (row.sha256 && row.sha256 !== hash) {
    throw new ConflictException("the attached document no longer matches the checksum recorded when it was uploaded");
  }
  return hash;
}
