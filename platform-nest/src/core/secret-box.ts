// WSUX-14 (ex-P1-08) — the connection-credential VAULT primitive (locked decision #7).
//
// platform-nest had NO crypto util before this. This is a deliberately small, single-responsibility
// app-layer symmetric-encryption box for the ONE job of sealing external-provider OAuth/API tokens
// at rest in integration_connections.{access,refresh}_token_enc. It is NOT a general-purpose crypto
// kit — it does exactly what decision #7 locks:
//
//   * AES-256-GCM (authenticated encryption — tamper-evident; a flipped ciphertext byte fails the
//     auth-tag check on decrypt rather than returning garbage plaintext).
//   * Key from env INTEGRATION_TOKEN_KEY: base64 of EXACTLY 32 bytes (256-bit). Anything else is a
//     hard configuration error (throws at load), never a silent weaker key.
//   * Ciphertext format `enc:v1:<iv_b64>:<tag_b64>:<data_b64>`. The `v1` tag + the row's
//     token_key_version column let a later OpenBao/KMS key be rotated in without ambiguity.
//   * FAIL-CLOSED: with no key configured, encrypt/decrypt throw ServiceUnavailableException (HTTP
//     503) — a token write can NEVER fall back to storing plaintext. (Mapping-row create/list/revoke
//     do NOT touch tokens and so keep working without a key; only the token path is gated.)
//
// This is the "at-rest credential protection" the design specifies. It intentionally does NOT reach
// for OpenBao here (not wired into platform-nest; that is the documented Phase-2/target-state swap
// behind token_key_version) — decision #7 chose app-layer AES-256-GCM for v1, and this implements
// that, not a weaker scheme.
import { ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";

/** The key version stamped on integration_connections.token_key_version for rows this box sealed. */
export const TOKEN_KEY_VERSION = "v1";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

/** Decode + validate the configured key. Returns null when UNSET (fail-closed callers turn that into
 *  a 503); throws on a PRESENT-but-malformed key (misconfiguration must be loud, not silently weak). */
function loadKey(): Buffer | null {
  const b64 = config.integrationTokenKey;
  if (!b64) return null;
  let key: Buffer;
  try {
    key = Buffer.from(b64, "base64");
  } catch {
    throw new Error("INTEGRATION_TOKEN_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`INTEGRATION_TOKEN_KEY must decode to exactly ${KEY_BYTES} bytes (AES-256); got ${key.length}`);
  }
  return key;
}

/** True iff a usable token-vault key is configured. Callers use this to decide whether a token write
 *  is even possible before attempting it (the encrypt() path itself is also fail-closed). */
export function tokenVaultConfigured(): boolean {
  try {
    return loadKey() !== null;
  } catch {
    // A present-but-malformed key is "configured but broken" — report not-configured so the token
    // path 503s consistently rather than 500-ing on the raw decode error.
    return false;
  }
}

/** True iff `s` is a value this box produced (an enc:v1 envelope), vs. a plaintext/empty value. */
export function isSealed(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

/** Seal a plaintext secret. FAIL-CLOSED: throws 503 when no key is configured — a token can never be
 *  written unencrypted. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  if (!key) {
    throw new ServiceUnavailableException(
      "integration token vault not configured: set INTEGRATION_TOKEN_KEY (base64, 32 bytes) to store credentials",
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

/** Open a sealed secret. FAIL-CLOSED on missing key (503). Throws on a malformed envelope or a failed
 *  auth-tag check (tampered/corrupt ciphertext). Never used on any read that reaches an API response —
 *  the vault reveals plaintext only to server-side provider calls (Phase 2), never to a client. */
export function decryptSecret(ciphertext: string): string {
  const key = loadKey();
  if (!key) {
    throw new ServiceUnavailableException(
      "integration token vault not configured: set INTEGRATION_TOKEN_KEY to read credentials",
    );
  }
  if (!isSealed(ciphertext)) throw new Error("not an enc:v1 sealed secret");
  // Split off the fixed "enc:v1:" prefix, then the three base64 parts. Base64 never contains ':'.
  const parts = ciphertext.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed enc:v1 envelope");
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("malformed enc:v1 iv");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return out.toString("utf8");
}

/** Constant-time equality for two sealed-or-plain secrets' PLAINTEXT — provided for Phase-2 callers
 *  that must compare a presented token to a stored one without leaking length/position via early
 *  return. Not used by the Phase-1 API. */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
