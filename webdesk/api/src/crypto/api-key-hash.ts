// WSK-05 — key material + at-rest hashing. §04's own DDL comment on `api_keys.key_hash`:
// "sha256(key + server pepper); plaintext shown ONCE at mint". This file is the only place that
// ever computes or compares that hash — every other file in this ticket only ever sees a plaintext
// key at the exact moment it is generated (mint/rotate's return value) or presented (the
// Authorization header on an incoming request), never in between.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "wdsk_";
const KEY_RANDOM_BYTES = 32; // 256 bits

/** A fresh plaintext key. Never logged, never persisted — the caller shows it exactly once. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString("base64url");
}

/** sha256(key + pepper), hex — what actually lives in `api_keys.key_hash`. */
export function hashApiKey(plaintextKey: string, pepper: string): string {
  return createHash("sha256").update(plaintextKey + pepper, "utf8").digest("hex");
}

/**
 * Constant-time compare of two hex hash strings. Used only as a defensive extra layer where a
 * caller already has a candidate hash to check against a known one (e.g. tests); the real
 * lookup path (api-keys.service.ts) always compares by an indexed equality query, which Postgres
 * itself does not do in variable time relative to secret bytes it never received unhashed.
 */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
