// WSK-37 — webhook secret material + at-rest protection.
//
// WHY THIS IS ENCRYPTION, NOT A ONE-WAY HASH (see 0006_tenant_webhooks.sql's own header for the
// full reasoning — reproduced briefly here since this is the file that implements it):
// api_keys.key_hash (crypto/api-key-hash.ts) is a VERIFICATION secret — Zone B only ever compares
// "does a freshly-hashed presented value match the stored hash", so sha256(value + pepper) is
// exactly the right primitive. A webhook secret is a SIGNING secret: the dispatcher must compute
// a fresh HMAC-SHA256 over new bytes (timestamp + body) on every delivery attempt, which requires
// the ORIGINAL secret bytes, not a hash of them — a one-way hash cannot be un-hashed to sign with.
// So this column holds AES-256-GCM ciphertext instead, keyed by TENANT_WEBHOOK_SECRET_PEPPER
// (Zone B env only, never in the database, never in git — identical custody model to
// API_KEY_PEPPER). A database-only compromise (no env access) yields nothing usable to forge a
// signature with; that is the actual property "hashed at rest" was reaching for, delivered by a
// different, correct primitive for a signing (rather than verifying) secret.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { tenantWebhooksConfig } from "./tenant-webhooks.config";

const SECRET_PREFIX = "whsec_";
const SECRET_RANDOM_BYTES = 32; // 256 bits
const GCM_IV_BYTES = 12;
const GCM_ALGO = "aes-256-gcm";

/** A fresh plaintext webhook secret. Never logged, never persisted in this form — the caller
 *  shows it exactly once (registration or rotation response), matching MintedApiKey's contract. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(SECRET_RANDOM_BYTES).toString("base64url");
}

function encryptionKey(): Buffer {
  // Deterministic 32-byte key derived from the pepper — sha256 output is exactly the AES-256 key
  // length, so this needs no separate KDF/salt storage; the pepper itself is the only secret.
  return createHash("sha256").update(tenantWebhooksConfig.secretPepper, "utf8").digest();
}

/** `base64(iv || authTag || ciphertext)` — everything needed to decrypt, nothing needed to sign
 *  without the pepper. Stored verbatim in `tenant_webhooks.secret_ciphertext`. */
export function encryptWebhookSecret(plaintextSecret: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(GCM_ALGO, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintextSecret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

/** Inverse of `encryptWebhookSecret`. Used ONLY inside the dispatcher/worker at the moment an HMAC
 *  is computed — the decrypted plaintext is never logged and never leaves that call stack. Throws
 *  if the ciphertext was tampered with or the pepper does not match (GCM auth-tag verification),
 *  which fails a delivery loudly rather than silently signing with garbage. */
export function decryptWebhookSecret(ciphertextB64: string): string {
  const raw = Buffer.from(ciphertextB64, "base64");
  const iv = raw.subarray(0, GCM_IV_BYTES);
  const authTag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + 16);
  const encrypted = raw.subarray(GCM_IV_BYTES + 16);
  const decipher = createDecipheriv(GCM_ALGO, encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
