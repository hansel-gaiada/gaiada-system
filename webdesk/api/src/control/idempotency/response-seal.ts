// M3 T5a — sealing for idempotency responses that carry a secret.
//
// key.mint and key.rotate return the plaintext api key, and an idempotent replay must return the
// same key (the caller retries after a lost response). The old in-memory store held that plaintext
// in process memory only. control_idempotency_keys.response is a plain jsonb column that lives for
// days, so the plaintext must not go there: WSK-05's rule (crypto/api-key-hash.ts) is that only the
// key's hash ever reaches the database. The response is therefore stored as AES-256-GCM ciphertext
// under a key derived (HKDF-SHA256, fixed salt and info) from API_KEY_PEPPER, the one secret that is
// already kept out of the database and out of git for exactly this purpose.
//
// The scope key is the GCM additional-authenticated-data, so a sealed blob copied onto another row
// does not open. A rotated pepper makes old blobs unreadable: open() throws and the envelope answers
// 409 idempotency-response-unreadable, never a wrong key.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { config } from "../../config";
import type { ResponseSeal } from "../command-envelope";

const VERSION = "v1";
const SALT = Buffer.from("webdesk.control_idempotency_keys.response.seal", "utf8");
const INFO = Buffer.from("aes-256-gcm v1", "utf8");

function deriveKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(config.apiKeyPepper, "utf8"), SALT, INFO, 32));
}

export function sealJson(value: unknown, aad: string): { sealed: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { sealed: [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".") };
}

export function openJson<T>(stored: unknown, aad: string): T {
  const sealed = (stored as { sealed?: unknown } | null)?.sealed;
  if (typeof sealed !== "string") throw new Error("response is not sealed");
  const [version, iv, tag, ct, extra] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !ct || extra !== undefined) throw new Error("unrecognised sealed response");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(plain) as T;
}

/** The ResponseSeal the envelope takes for a command whose response holds plaintext key material. */
export function sealedResponse<R extends object>(): ResponseSeal<R> {
  return { seal: (result, aad) => sealJson(result, aad), open: (stored, aad) => openJson<R>(stored, aad) };
}
