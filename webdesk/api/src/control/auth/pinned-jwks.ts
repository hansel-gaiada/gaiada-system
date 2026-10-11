// The pinned Ed25519 JWKS loader, shared by every channel that verifies an ERP-signed assertion
// (generalised from WSK-40's editorial-jwks.ts for M4 F1, the WS4 v2 assertion).
//
// Two channels use it today, each with ITS OWN file, ITS OWN env variable and ITS OWN key map:
//   - editorial  WEBDESK_EDITORIAL_JWKS_FILE  ./editorial-jwks.ts  (x-webdesk-editorial-assertion)
//   - WS4 v2     WEBDESK_WS4_JWKS_FILE        ./ws4-jwks.ts        (x-ws4-assertion, three-part form)
// This file holds no keys and no state. It only parses and shape-checks; each channel wraps it with
// its own error class, so a message always names the channel whose file was refused, and the
// editorial wording is exactly what it was before the split.
//
// THE CA-LOADER DISCIPLINE (real-control-channel-authenticator.ts loadPinnedCaPem): a file that is
// present but wrong (truncated JSON, an RSA/EC/X25519/Ed448 key, private material, a short `x`, a
// duplicate kid, 0 or 3+ keys) REFUSES BOOT with a message naming the file and the reason, never the
// contents. A truncated key set must never look like a working one.
//
// ABSENT is different, on purpose: when the variable is unset, or names a path that does not exist
// or is a directory (what a compose short-syntax bind mount of a missing host file creates), the
// caller gets `not-configured` and decides what that means for its channel.
import { createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** Hard ceiling. A JWKS of two OKP keys is ~300 bytes; anything near this is not a JWKS. */
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_KEYS = 2;
const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** An Ed25519 public key is 32 bytes = 43 base64url characters, unpadded. */
const ED25519_X_RE = /^[A-Za-z0-9_-]{43}$/;
/** Members a public OKP JWK may carry. Anything else (notably `d`, `p`, `q`, `k`) refuses. */
const ALLOWED_MEMBERS = new Set(["kty", "crv", "kid", "x", "use", "alg", "key_ops"]);

/** kid → public KeyObject (Ed25519). Immutable after load. */
export type PinnedKeySet = ReadonlyMap<string, KeyObject>;

/** Builds the channel's own error (its class and its wording) from the file name and the reason. */
export type PinnedJwksErrorFactory = (source: string, reason: string) => Error;

/**
 * Parses and shape-validates a JWKS document. Throws `fail(source, reason)` on anything but 1..2
 * well-formed public Ed25519 keys with distinct kids. `source` names the file in the error.
 */
export function parsePinnedEd25519Jwks(text: string, source: string, fail: PinnedJwksErrorFactory): PinnedKeySet {
  if (text.length === 0) throw fail(source, "the file is empty");
  if (text.length > MAX_JWKS_BYTES) throw fail(source, `the file is ${text.length} bytes (max ${MAX_JWKS_BYTES})`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw fail(source, `not valid JSON (truncated?) — ${(err as Error).message} (${text.length} bytes)`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw fail(source, "the document is not a JSON object");
  }
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw fail(source, 'the document has no "keys" array');
  if (keys.length < 1 || keys.length > MAX_KEYS) {
    throw fail(source, `expected 1..${MAX_KEYS} keys (2 only during a rotation overlap), found ${keys.length}`);
  }

  const out = new Map<string, KeyObject>();
  keys.forEach((raw, i) => {
    const at = `keys[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw fail(source, `${at} is not an object`);
    const jwk = raw as Record<string, unknown>;
    for (const member of Object.keys(jwk)) {
      if (!ALLOWED_MEMBERS.has(member)) {
        // `d` is the private scalar: a signing key on the delivery surface is exactly what D39 forbids.
        throw fail(
          source,
          member === "d" ? `${at} carries PRIVATE key material ("d") — WebDesk holds public keys only (D39)` : `${at} has unexpected member "${member}"`,
        );
      }
    }
    if (jwk.kty !== "OKP") throw fail(source, `${at}.kty must be "OKP" (Ed25519), got ${JSON.stringify(jwk.kty)}`);
    if (jwk.crv !== "Ed25519") throw fail(source, `${at}.crv must be "Ed25519", got ${JSON.stringify(jwk.crv)}`);
    if (typeof jwk.kid !== "string" || !KID_RE.test(jwk.kid)) throw fail(source, `${at}.kid must match ${KID_RE}`);
    if (typeof jwk.x !== "string" || !ED25519_X_RE.test(jwk.x)) {
      throw fail(source, `${at}.x must be a 32-byte base64url Ed25519 public key (43 chars)`);
    }
    if (jwk.use !== undefined && jwk.use !== "sig") throw fail(source, `${at}.use must be "sig" when present`);
    if (jwk.alg !== undefined && jwk.alg !== "EdDSA") throw fail(source, `${at}.alg must be "EdDSA" when present`);
    if (out.has(jwk.kid)) throw fail(source, `duplicate kid "${jwk.kid}"`);
    let key: KeyObject;
    try {
      key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
    } catch (err) {
      throw fail(source, `${at} does not import as an Ed25519 public key (${(err as Error).message})`);
    }
    if (key.asymmetricKeyType !== "ed25519") throw fail(source, `${at} is not an Ed25519 key`);
    out.set(jwk.kid, key);
  });
  return out;
}

export type PinnedJwksLoad =
  | { state: "configured"; keys: PinnedKeySet; source: string }
  | { state: "not-configured"; reason: string };

/**
 * Reads the JWKS file at `filePath`, which came from the env variable `envName` (named in every
 * message). Absent → not-configured. Present and wrong → throws `fail(...)` (boot refused).
 */
export function loadPinnedEd25519Jwks(envName: string, filePath: string | undefined, fail: PinnedJwksErrorFactory): PinnedJwksLoad {
  if (!filePath || filePath.trim().length === 0) {
    return { state: "not-configured", reason: `${envName} is not set` };
  }
  const source = `${envName} ('${filePath}')`;
  let isFile: boolean;
  try {
    isFile = statSync(filePath).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "not-configured", reason: `${source} does not exist` };
    throw fail(source, `cannot stat the file (${code ?? (err as Error).message})`);
  }
  if (!isFile) {
    // A bind mount of a missing host file makes Docker create an empty DIRECTORY in its place.
    return { state: "not-configured", reason: `${source} is not a regular file (a bind mount of a missing host file?)` };
  }
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw fail(source, `cannot read the file (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  return { state: "configured", keys: parsePinnedEd25519Jwks(text, source, fail), source };
}

/** The raw 32 public-key bytes of an Ed25519 KeyObject, base64url (the JWK `x`). */
export function ed25519PublicX(key: KeyObject): string {
  return key.export({ format: "jwk" }).x as string;
}
