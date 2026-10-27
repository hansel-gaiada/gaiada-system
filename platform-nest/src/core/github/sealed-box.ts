// M6-P6o (WSK-D88) — seal a value for a GitHub Actions secret: a libsodium SEALED BOX (`crypto_box_seal`) to the
// organisation's Actions public key, which is the only encryption GitHub's secrets API accepts
// (`PUT /orgs/{org}/actions/secrets/{name}` takes `encrypted_value`, base64 of the sealed box, plus the key's `key_id`).
//
// ── WHY libsodium-wrappers ──────────────────────────────────────────────────────────────────────────
// A sealed box is X25519 + an ephemeral key + XSalsa20-Poly1305 with a BLAKE2b-derived nonce. Node's own crypto has
// X25519 but neither XSalsa20-Poly1305 nor a 24-byte BLAKE2b, so the construction cannot be built from it without
// hand-assembling cryptography, which this file refuses to do. `libsodium-wrappers` is libsodium itself compiled to
// WebAssembly (the reference implementation, one runtime dependency: `libsodium`, no install scripts, no network), and it
// is the library GitHub's own documentation uses for this exact call. Pinned exactly in package.json.
//
// ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────────────────────────────
// It never logs, never returns the plaintext, and holds nothing after it returns. The caller owns the plaintext's
// lifetime (modules/webdev/deploy-secret-write.ts decrypts the vault value inside the write and drops it after sealing).
// It has no network call (egress-inventory.test.ts keeps http-client.ts the only outbound file).
import sodium from "libsodium-wrappers";

/** An X25519 public key is 32 bytes. GitHub hands it out as base64 (`GET /orgs/{org}/actions/secrets/public-key`). */
export const SEALED_BOX_PUBLIC_KEY_BYTES = 32;

export class SealedBoxKeyError extends Error {
  constructor(detail: string) {
    super(`not a GitHub Actions public key: ${detail}`);
    this.name = "SealedBoxKeyError";
  }
}

/** Decode GitHub's base64 public key (standard alphabet, padded) and check it is 32 bytes. */
export function decodeGithubPublicKey(keyBase64: string): Buffer {
  if (typeof keyBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(keyBase64)) throw new SealedBoxKeyError("not base64");
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== SEALED_BOX_PUBLIC_KEY_BYTES) throw new SealedBoxKeyError(`decodes to ${key.length} bytes, not ${SEALED_BOX_PUBLIC_KEY_BYTES}`);
  return key;
}

/**
 * Seal `plaintext` (UTF-8) to `publicKeyBase64`. Returns the sealed box as base64 (standard alphabet), exactly what
 * GitHub's `encrypted_value` takes. Every call uses a fresh ephemeral key, so two seals of one value differ.
 */
export async function sealForGithubSecret(publicKeyBase64: string, plaintext: string): Promise<string> {
  const key = decodeGithubPublicKey(publicKeyBase64);
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("refusing to seal an empty secret value");
  await sodium.ready;
  const message = Buffer.from(plaintext, "utf8");
  try {
    const sealed = sodium.crypto_box_seal(new Uint8Array(message), new Uint8Array(key));
    return Buffer.from(sealed).toString("base64");
  } finally {
    message.fill(0);
  }
}
