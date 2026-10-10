// WSK-40 — the pinned editorial JWKS (write-plane design §5, Decision D; ruling WSK-D39).
//
// WebDesk VERIFIES editorial assertions and never mints them: the only key material on this side is
// a PUBLIC Ed25519 key set, read from a FILE that the operator mounts read-only
// (`WEBDESK_EDITORIAL_JWKS_FILE`, docker-compose.aicenter.yml). There is no JWKS URL and no key push
// over the control channel: no new channel, no new egress. Same channel class as the pinned mTLS CA.
//
// File shape (what platform-nest/scripts/webdesk-editorial-keygen.mjs writes):
//   { "keys": [ { "kty": "OKP", "crv": "Ed25519", "kid": "wde-2026-10", "x": "<43 base64url chars>",
//                 "use": "sig", "alg": "EdDSA" } ] }
// One key normally, two during a rotation overlap (infra/runbooks/webdesk-editorial-keys.md).
//
// THE CA-LOADER DISCIPLINE (real-control-channel-authenticator.ts loadPinnedCaPem): a file that is
// present but wrong (truncated JSON, an RSA/EC/X25519/Ed448 key, private material, a short `x`, a
// duplicate kid, 0 or 3+ keys) REFUSES BOOT with a message naming the file and the reason, never the
// contents. A truncated key set must never look like a working one.
//
// ABSENT is different, on purpose (WSK-40 brief): when the variable is unset, or names a path that
// does not exist or is a directory (what a compose short-syntax bind mount of a missing host file
// creates), the instance boots and every content write answers 503 editorial-keys-not-configured.
// Refusing boot there would take the /v1 delivery surface down with the write plane, for a key that
// the operator simply has not installed yet. Writes fail closed either way.
import { createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const EDITORIAL_JWKS_FILE_ENV = "WEBDESK_EDITORIAL_JWKS_FILE";

/** Hard ceiling. A JWKS of two OKP keys is ~300 bytes; anything near this is not a JWKS. */
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_KEYS = 2;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** An Ed25519 public key is 32 bytes = 43 base64url characters, unpadded. */
const ED25519_X_RE = /^[A-Za-z0-9_-]{43}$/;
/** Members a public OKP JWK may carry. Anything else (notably `d`, `p`, `q`, `k`) refuses. */
const ALLOWED_MEMBERS = new Set(["kty", "crv", "kid", "x", "use", "alg", "key_ops"]);

/** kid → public KeyObject (Ed25519). Immutable after load. */
export type EditorialKeySet = ReadonlyMap<string, KeyObject>;

export class EditorialJwksError extends Error {
  constructor(source: string, reason: string) {
    super(`[webdesk:api] editorial JWKS from ${source} refused: ${reason} — refusing to boot the editorial assertion verifier.`);
    this.name = "EditorialJwksError";
  }
}

/**
 * Parses and shape-validates a JWKS document. Throws EditorialJwksError on anything but 1..2
 * well-formed public Ed25519 keys with distinct kids. `source` names the file in the error.
 */
export function parseEditorialJwks(text: string, source: string): EditorialKeySet {
  if (text.length === 0) throw new EditorialJwksError(source, "the file is empty");
  if (text.length > MAX_JWKS_BYTES) throw new EditorialJwksError(source, `the file is ${text.length} bytes (max ${MAX_JWKS_BYTES})`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new EditorialJwksError(source, `not valid JSON (truncated?) — ${(err as Error).message} (${text.length} bytes)`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new EditorialJwksError(source, "the document is not a JSON object");
  }
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw new EditorialJwksError(source, 'the document has no "keys" array');
  if (keys.length < 1 || keys.length > MAX_KEYS) {
    throw new EditorialJwksError(source, `expected 1..${MAX_KEYS} keys (2 only during a rotation overlap), found ${keys.length}`);
  }

  const out = new Map<string, KeyObject>();
  keys.forEach((raw, i) => {
    const at = `keys[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new EditorialJwksError(source, `${at} is not an object`);
    const jwk = raw as Record<string, unknown>;
    for (const member of Object.keys(jwk)) {
      if (!ALLOWED_MEMBERS.has(member)) {
        // `d` is the private scalar: a signing key on the delivery surface is exactly what D39 forbids.
        throw new EditorialJwksError(
          source,
          member === "d" ? `${at} carries PRIVATE key material ("d") — WebDesk holds public keys only (D39)` : `${at} has unexpected member "${member}"`,
        );
      }
    }
    if (jwk.kty !== "OKP") throw new EditorialJwksError(source, `${at}.kty must be "OKP" (Ed25519), got ${JSON.stringify(jwk.kty)}`);
    if (jwk.crv !== "Ed25519") throw new EditorialJwksError(source, `${at}.crv must be "Ed25519", got ${JSON.stringify(jwk.crv)}`);
    if (typeof jwk.kid !== "string" || !KID_RE.test(jwk.kid)) throw new EditorialJwksError(source, `${at}.kid must match ${KID_RE}`);
    if (typeof jwk.x !== "string" || !ED25519_X_RE.test(jwk.x)) {
      throw new EditorialJwksError(source, `${at}.x must be a 32-byte base64url Ed25519 public key (43 chars)`);
    }
    if (jwk.use !== undefined && jwk.use !== "sig") throw new EditorialJwksError(source, `${at}.use must be "sig" when present`);
    if (jwk.alg !== undefined && jwk.alg !== "EdDSA") throw new EditorialJwksError(source, `${at}.alg must be "EdDSA" when present`);
    if (out.has(jwk.kid)) throw new EditorialJwksError(source, `duplicate kid "${jwk.kid}"`);
    let key: KeyObject;
    try {
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    } catch (err) {
      throw new EditorialJwksError(source, `${at} does not import as an Ed25519 public key (${(err as Error).message})`);
    }
    if (key.asymmetricKeyType !== "ed25519") throw new EditorialJwksError(source, `${at} is not an Ed25519 key`);
    out.set(jwk.kid, key);
  });
  return out;
}

export type EditorialJwksLoad =
  | { state: "configured"; keys: EditorialKeySet; source: string }
  | { state: "not-configured"; reason: string };

/**
 * Reads `WEBDESK_EDITORIAL_JWKS_FILE` (or `filePath` when given). Absent → not-configured (the
 * caller answers 503 on every write). Present and wrong → throws (boot refused).
 */
export function loadEditorialJwks(filePath: string | undefined = process.env[EDITORIAL_JWKS_FILE_ENV]): EditorialJwksLoad {
  if (!filePath || filePath.trim().length === 0) {
    return { state: "not-configured", reason: `${EDITORIAL_JWKS_FILE_ENV} is not set` };
  }
  const source = `${EDITORIAL_JWKS_FILE_ENV} ('${filePath}')`;
  let isFile: boolean;
  try {
    isFile = statSync(filePath).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "not-configured", reason: `${source} does not exist` };
    throw new EditorialJwksError(source, `cannot stat the file (${code ?? (err as Error).message})`);
  }
  if (!isFile) {
    // A bind mount of a missing host file makes Docker create an empty DIRECTORY in its place.
    return { state: "not-configured", reason: `${source} is not a regular file (a bind mount of a missing host file?)` };
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new EditorialJwksError(source, `cannot read the file (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  return { state: "configured", keys: parseEditorialJwks(text, source), source };
}
